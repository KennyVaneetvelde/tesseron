#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>

#include <tesseron/json.hpp>

namespace tesseron {

/// The descriptor a running application writes so the gateway can find it.
///
/// The `version` integer stays at 2 even as optional fields are added:
/// released gateways compare it strictly, so bumping it would make them skip a
/// manifest they can otherwise read.
struct InstanceManifest {
  int version = 2;
  /// Unique per running instance; also the manifest's file name.
  std::string instance_id;
  /// Human-readable application name, shown by the gateway.
  std::string application_name;
  /// Unix-millisecond timestamp of when the manifest was written.
  std::int64_t added_at = 0;
  /// Process that owns this instance. Gateways probe it and tombstone
  /// manifests whose owner is gone.
  std::optional<std::uint32_t> process_id;
  /// Full `ws://host:port/path` URL the gateway dials.
  std::string websocket_url;

  [[nodiscard]] static InstanceManifest for_websocket(std::string instance_id,
                                                      std::string application_name,
                                                      std::string websocket_url);

  [[nodiscard]] Json to_json() const;
};

/// Where, or whether, a host publishes its instance manifest.
///
/// Disabling publication is what a test harness wants: the conformance runner
/// dials the host directly and must never touch the developer's
/// `~/.tesseron/instances`.
class ManifestPublication {
 public:
  enum class Mode { DefaultDirectory, Directory, Disabled };

  /// Publish to `~/.tesseron/instances`, where the gateway watches.
  [[nodiscard]] static ManifestPublication default_directory();
  /// Publish to a directory chosen by the caller.
  [[nodiscard]] static ManifestPublication directory(std::filesystem::path path);
  /// Publish nothing. The instance is only reachable by an address the caller
  /// hands out itself.
  [[nodiscard]] static ManifestPublication disabled();

  [[nodiscard]] Mode mode() const noexcept { return mode_; }
  [[nodiscard]] const std::filesystem::path& path() const noexcept { return path_; }

 private:
  ManifestPublication() = default;

  Mode mode_ = Mode::DefaultDirectory;
  std::filesystem::path path_;
};

}  // namespace tesseron
