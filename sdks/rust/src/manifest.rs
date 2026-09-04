use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::HostError;

/// Instance manifests live in a private directory: owner read, write, execute.
#[cfg(unix)]
const DIRECTORY_MODE: u32 = 0o700;
/// The manifest itself is owner-only: it names an endpoint anyone who can read
/// it may dial.
#[cfg(unix)]
const FILE_MODE: u32 = 0o600;

static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// How the gateway can reach a running application.
///
/// The set is closed on purpose: a new binding means a new discriminant here
/// and a new dialer in the gateway. This release writes `ws` only.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[non_exhaustive]
pub enum TransportSpecification {
    /// A loopback WebSocket endpoint the gateway dials with the
    /// `tesseron-gateway` subprotocol.
    Ws {
        /// Full `ws://host:port/path` URL.
        url: String,
    },
}

/// The descriptor a running application writes so the gateway can find it.
///
/// The `version` integer stays at 2 even as optional fields are added: released
/// gateways compare it strictly, so bumping it would make them skip a manifest
/// they can otherwise read. The type definition is the contract, not the
/// integer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceManifest {
    /// Always 2. See the type's own documentation for why it does not move.
    pub version: u8,
    /// Unique per running instance; also the manifest's file name.
    pub instance_id: String,
    /// Human-readable application name, shown by the gateway.
    pub app_name: String,
    /// Unix-millis timestamp of when the manifest was written.
    pub added_at: i64,
    /// Process that owns this instance. Gateways probe it and tombstone
    /// manifests whose owner is gone, so a killed process leaves no corpse the
    /// gateway keeps re-dialling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// How to reach the instance.
    pub transport: TransportSpecification,
}

impl InstanceManifest {
    /// Describes a WebSocket instance owned by the current process.
    #[must_use]
    pub fn for_websocket(instance_id: String, app_name: String, url: String) -> Self {
        Self {
            version: 2,
            instance_id,
            app_name,
            added_at: unix_milliseconds(),
            pid: Some(std::process::id()),
            transport: TransportSpecification::Ws { url },
        }
    }
}

/// Where, or whether, a host publishes its instance manifest.
///
/// Disabling publication is what a test harness wants: the conformance runner
/// dials the host directly and must never touch the developer's
/// `~/.tesseron/instances`.
#[derive(Clone, Debug, Default)]
pub enum ManifestPublication {
    /// Publish to `~/.tesseron/instances`, where the gateway watches.
    #[default]
    DefaultDirectory,
    /// Publish to a directory chosen by the caller.
    Directory(PathBuf),
    /// Publish nothing. The instance is only reachable by an address the caller
    /// hands out itself.
    Disabled,
}

/// Mints an identifier unique among the instances one process runs.
///
/// Uniqueness only has to hold inside `~/.tesseron/instances` for one user, and
/// process id plus start time plus a counter gives that without pulling in a
/// random number generator.
pub(crate) fn mint_instance_id() -> String {
    let sequence = INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "inst-{:x}-{:x}-{sequence:x}",
        std::process::id(),
        unix_milliseconds()
    )
}

/// Resolves `~/.tesseron/instances` from the environment.
pub(crate) fn default_instance_directory() -> Result<PathBuf, HostError> {
    let home = home_directory().ok_or(HostError::HomeDirectoryUnknown)?;
    Ok(home.join(".tesseron").join("instances"))
}

/// Reads the home directory the same way the gateway does.
///
/// `USERPROFILE` comes first on Windows because a shell such as Git Bash also
/// exports `HOME`, pointing at an emulation root the gateway never scans.
fn home_directory() -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    };
    candidates
        .into_iter()
        .filter_map(std::env::var_os)
        .find(|home| !home.is_empty())
        .map(PathBuf::from)
}

trait StagingFile {
    fn write_manifest(&mut self, bytes: &[u8]) -> std::io::Result<()>;
    fn sync_manifest(&mut self) -> std::io::Result<()>;
}

impl StagingFile for fs::File {
    fn write_manifest(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.write_all(bytes)
    }

    fn sync_manifest(&mut self) -> std::io::Result<()> {
        self.sync_all()
    }
}

/// Writes the manifest into `directory` and returns the file it created.
///
/// The write is atomic through a rename so a gateway watching the directory
/// never reads a half-written file, and the temporary file is created with the
/// final mode so the endpoint is never briefly world-readable.
///
/// This is deliberately synchronous. It runs once when the host starts and once
/// when it stops, both outside any request path, and a blocking call there is
/// cheaper to read than an async file API that only exists for two calls.
pub(crate) fn publish(manifest: &InstanceManifest, directory: &Path) -> Result<PathBuf, HostError> {
    publish_with_staging_file(manifest, directory, create_private_file)
}

fn publish_with_staging_file<File, CreateFile>(
    manifest: &InstanceManifest,
    directory: &Path,
    create_file: CreateFile,
) -> Result<PathBuf, HostError>
where
    File: StagingFile,
    CreateFile: FnOnce(&Path) -> Result<File, HostError>,
{
    fs::create_dir_all(directory).map_err(HostError::Manifest)?;
    tighten_directory(directory)?;

    let destination = directory.join(format!("{}.json", manifest.instance_id));
    let staging = directory.join(format!("{}.json.partial", manifest.instance_id));
    let encoded = serde_json::to_vec(manifest)
        .map_err(|problem| HostError::Manifest(std::io::Error::other(problem)))?;

    let mut file = create_file(&staging)?;
    let result = file
        .write_manifest(&encoded)
        .and_then(|()| file.sync_manifest());
    drop(file);
    if let Err(problem) = result {
        remove_staging_file(&staging);
        return Err(HostError::Manifest(problem));
    }

    fs::rename(&staging, &destination).map_err(|problem| {
        remove_staging_file(&staging);
        HostError::Manifest(problem)
    })?;
    Ok(destination)
}

fn remove_staging_file(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Removes a published manifest. A manifest that is already gone is a success:
/// the goal is that nothing is left behind, not that this call did the removing.
pub(crate) fn withdraw(path: &Path) -> Result<(), HostError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(problem) => Err(HostError::Manifest(problem)),
    }
}

#[cfg(unix)]
fn tighten_directory(directory: &Path) -> Result<(), HostError> {
    use std::os::unix::fs::PermissionsExt as _;

    fs::set_permissions(directory, fs::Permissions::from_mode(DIRECTORY_MODE))
        .map_err(HostError::Manifest)
}

/// POSIX modes are advisory on Windows, where the user account is the gate, so
/// the directory is created with whatever the account's defaults are.
#[cfg(not(unix))]
fn tighten_directory(_directory: &Path) -> Result<(), HostError> {
    Ok(())
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> Result<fs::File, HostError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(FILE_MODE)
        .open(path)
        .map_err(HostError::Manifest)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> Result<fs::File, HostError> {
    fs::File::create(path).map_err(HostError::Manifest)
}

fn unix_milliseconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since_epoch| {
            i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_published_manifest_carries_the_version_two_shape() {
        let directory =
            std::env::temp_dir().join(format!("tesseron-manifest-{}", mint_instance_id()));
        let manifest = InstanceManifest::for_websocket(
            mint_instance_id(),
            "todo".to_owned(),
            "ws://127.0.0.1:1234/".to_owned(),
        );
        let path = publish(&manifest, &directory).unwrap();

        let written: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["version"], 2);
        assert_eq!(written["appName"], "todo");
        assert_eq!(written["transport"]["kind"], "ws");
        assert_eq!(written["transport"]["url"], "ws://127.0.0.1:1234/");
        assert!(written["addedAt"].is_i64());
        assert!(
            !directory
                .join(format!("{}.json.partial", manifest.instance_id))
                .exists()
        );

        withdraw(&path).unwrap();
        assert!(!path.exists());
        withdraw(&path).unwrap();
        fs::remove_dir_all(&directory).ok();
    }

    #[cfg(unix)]
    #[test]
    fn published_manifests_are_owner_only_inside_an_owner_only_directory() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = std::env::temp_dir().join(format!("tesseron-mode-{}", mint_instance_id()));
        let manifest = InstanceManifest::for_websocket(
            mint_instance_id(),
            "todo".to_owned(),
            "ws://127.0.0.1:1234/".to_owned(),
        );
        let path = publish(&manifest, &directory).unwrap();

        let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let directory_mode = fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, FILE_MODE);
        assert_eq!(directory_mode, DIRECTORY_MODE);

        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_staging_file_is_removed_when_the_final_rename_fails() {
        let directory =
            std::env::temp_dir().join(format!("tesseron-partial-{}", mint_instance_id()));
        let manifest = InstanceManifest::for_websocket(
            mint_instance_id(),
            "todo".to_owned(),
            "ws://127.0.0.1:1234/".to_owned(),
        );
        let destination = directory.join(format!("{}.json", manifest.instance_id));
        fs::create_dir_all(&destination).unwrap();

        let result = publish(&manifest, &directory);
        let staging = directory.join(format!("{}.json.partial", manifest.instance_id));
        assert!(result.is_err());
        assert!(!staging.exists());

        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_staging_file_is_removed_when_its_write_or_sync_fails() {
        for fail_sync in [false, true] {
            let directory =
                std::env::temp_dir().join(format!("tesseron-partial-{}", mint_instance_id()));
            let manifest = InstanceManifest::for_websocket(
                mint_instance_id(),
                "todo".to_owned(),
                "ws://127.0.0.1:1234/".to_owned(),
            );
            let staging = directory.join(format!("{}.json.partial", manifest.instance_id));
            let result = publish_with_staging_file(&manifest, &directory, |path| {
                fs::create_dir_all(&directory).map_err(HostError::Manifest)?;
                fs::File::create(path).map_err(HostError::Manifest)?;
                Ok(FailingStagingFile { fail_sync })
            });

            assert!(result.is_err());
            assert!(
                !staging.exists(),
                "a failed staging write must not leave {} behind",
                staging.display()
            );
            fs::remove_dir_all(&directory).ok();
        }
    }

    struct FailingStagingFile {
        fail_sync: bool,
    }

    impl StagingFile for FailingStagingFile {
        fn write_manifest(&mut self, _bytes: &[u8]) -> std::io::Result<()> {
            if self.fail_sync {
                Ok(())
            } else {
                Err(std::io::Error::other("injected write failure"))
            }
        }

        fn sync_manifest(&mut self) -> std::io::Result<()> {
            if self.fail_sync {
                Err(std::io::Error::other("injected sync failure"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn instance_ids_do_not_collide_inside_one_process() {
        assert_ne!(mint_instance_id(), mint_instance_id());
    }
}
