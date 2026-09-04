#pragma once

#include <filesystem>
#include <string>

#include <tesseron/error.hpp>
#include <tesseron/manifest.hpp>

namespace tesseron::detail {

/// Mints an identifier unique among the instances one process runs.
///
/// Uniqueness only has to hold inside `~/.tesseron/instances` for one user, and
/// process id plus start time plus a counter gives that without pulling in a
/// random number generator.
[[nodiscard]] std::string mint_instance_id();

/// Resolves `~/.tesseron/instances` from the environment.
[[nodiscard]] Result<std::filesystem::path, HostError> default_instance_directory();

/// Writes the manifest into `directory` and answers the file it created.
///
/// The write is atomic through a rename so a gateway watching the directory
/// never reads a half-written file, and the staged file is created with the
/// final mode so the endpoint is never briefly world-readable. On Windows the
/// mode is advisory: the file inherits the directory's access control list,
/// which for a per-user profile directory is already owner-only.
[[nodiscard]] Result<std::filesystem::path, HostError> publish_manifest(
    const InstanceManifest& manifest, const std::filesystem::path& directory);

/// Removes a published manifest. A manifest that is already gone is a success:
/// the goal is that nothing is left behind, not that this call did the removing.
[[nodiscard]] Result<void, HostError> withdraw_manifest(const std::filesystem::path& path);

}  // namespace tesseron::detail
