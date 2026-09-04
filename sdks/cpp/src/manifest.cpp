#include <tesseron/manifest.hpp>

#include "manifest_store.hpp"

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <system_error>
#include <utility>

#ifdef _WIN32
#include <process.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace tesseron {
namespace {

std::int64_t unix_milliseconds() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

std::uint32_t current_process_id() {
#ifdef _WIN32
  return static_cast<std::uint32_t>(::_getpid());
#else
  return static_cast<std::uint32_t>(::getpid());
#endif
}

}  // namespace

InstanceManifest InstanceManifest::for_websocket(std::string instance_id,
                                                 std::string application_name,
                                                 std::string websocket_url) {
  InstanceManifest manifest;
  manifest.instance_id = std::move(instance_id);
  manifest.application_name = std::move(application_name);
  manifest.added_at = unix_milliseconds();
  manifest.process_id = current_process_id();
  manifest.websocket_url = std::move(websocket_url);
  return manifest;
}

Json InstanceManifest::to_json() const {
  Json transport = Json::object();
  transport["kind"] = "ws";
  transport["url"] = websocket_url;

  Json document = Json::object();
  document["version"] = version;
  document["instanceId"] = instance_id;
  document["appName"] = application_name;
  document["addedAt"] = added_at;
  if (process_id.has_value()) document["pid"] = *process_id;
  document["transport"] = std::move(transport);
  return document;
}

ManifestPublication ManifestPublication::default_directory() {
  ManifestPublication publication;
  publication.mode_ = Mode::DefaultDirectory;
  return publication;
}

ManifestPublication ManifestPublication::directory(std::filesystem::path path) {
  ManifestPublication publication;
  publication.mode_ = Mode::Directory;
  publication.path_ = std::move(path);
  return publication;
}

ManifestPublication ManifestPublication::disabled() {
  ManifestPublication publication;
  publication.mode_ = Mode::Disabled;
  return publication;
}

namespace detail {
namespace {

std::atomic<std::uint64_t> instance_counter{0};

HostError manifest_failure(const std::string& what, const std::error_code& reason) {
  return HostError(HostError::Kind::Manifest, what + ": " + reason.message());
}

std::optional<std::string> read_environment(const char* name) {
#ifdef _WIN32
  // The Windows CRT deprecates `getenv` in favour of this, and a deprecation
  // warning here would be noise in every consumer's build log.
  char* value = nullptr;
  std::size_t length = 0;
  if (::_dupenv_s(&value, &length, name) != 0 || value == nullptr) return std::nullopt;
  std::string copied(value);
  std::free(value);
  if (copied.empty()) return std::nullopt;
  return copied;
#else
  const char* const value = std::getenv(name);
  if (value == nullptr || *value == '\0') return std::nullopt;
  return std::string(value);
#endif
}

std::optional<std::filesystem::path> home_directory() {
  // `USERPROFILE` comes first on Windows because a shell such as Git Bash also
  // exports `HOME`, pointing at an emulation root the gateway never scans.
#ifdef _WIN32
  const char* const candidates[] = {"USERPROFILE", "HOME"};
#else
  const char* const candidates[] = {"HOME", "USERPROFILE"};
#endif
  for (const char* name : candidates) {
    if (const auto value = read_environment(name)) return std::filesystem::path(*value);
  }
  return std::nullopt;
}

/// Writes `content` to `path` with owner-only permissions where the platform
/// has them, and flushes it to the device before returning.
std::error_code write_private_file(const std::filesystem::path& path, const std::string& content) {
#ifdef _WIN32
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  if (!file) return std::make_error_code(std::errc::permission_denied);
  file.write(content.data(), static_cast<std::streamsize>(content.size()));
  file.flush();
  if (!file) return std::make_error_code(std::errc::io_error);
  return {};
#else
  const int descriptor = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (descriptor < 0) return std::error_code(errno, std::generic_category());
  std::size_t written = 0;
  while (written < content.size()) {
    const auto chunk = ::write(descriptor, content.data() + written, content.size() - written);
    if (chunk <= 0) {
      const std::error_code failure(errno, std::generic_category());
      ::close(descriptor);
      return failure;
    }
    written += static_cast<std::size_t>(chunk);
  }
  if (::fsync(descriptor) != 0) {
    const std::error_code failure(errno, std::generic_category());
    ::close(descriptor);
    return failure;
  }
  ::close(descriptor);
  return {};
#endif
}

std::error_code tighten_directory(const std::filesystem::path& directory) {
#ifdef _WIN32
  (void)directory;
  return {};
#else
  if (::chmod(directory.c_str(), 0700) != 0) return std::error_code(errno, std::generic_category());
  return {};
#endif
}

}  // namespace

std::string mint_instance_id() {
  const auto sequence = instance_counter.fetch_add(1, std::memory_order_relaxed);
  std::ostringstream identifier;
  identifier << "inst-" << std::hex << current_process_id() << '-' << unix_milliseconds() << '-'
             << sequence;
  return identifier.str();
}

Result<std::filesystem::path, HostError> default_instance_directory() {
  const auto home = home_directory();
  if (!home.has_value()) {
    return HostError(HostError::Kind::HomeDirectoryUnknown,
                     "neither HOME nor USERPROFILE names a home directory");
  }
  return *home / ".tesseron" / "instances";
}

Result<std::filesystem::path, HostError> publish_manifest(
    const InstanceManifest& manifest, const std::filesystem::path& directory) {
  std::error_code failure;
  std::filesystem::create_directories(directory, failure);
  if (failure) return manifest_failure("could not create the instance directory", failure);
  if (const auto tightening = tighten_directory(directory)) {
    return manifest_failure("could not restrict the instance directory", tightening);
  }

  const auto destination = directory / (manifest.instance_id + ".json");
  const auto staging = directory / (manifest.instance_id + ".json.partial");
  if (const auto writing = write_private_file(staging, manifest.to_json().dump())) {
    return manifest_failure("could not write the instance manifest", writing);
  }

  std::filesystem::rename(staging, destination, failure);
  if (failure) {
    std::error_code ignored;
    std::filesystem::remove(staging, ignored);
    return manifest_failure("could not publish the instance manifest", failure);
  }
  return destination;
}

Result<void, HostError> withdraw_manifest(const std::filesystem::path& path) {
  std::error_code failure;
  std::filesystem::remove(path, failure);
  if (failure) return manifest_failure("could not remove the instance manifest", failure);
  return Result<void, HostError>::success();
}

}  // namespace detail

}  // namespace tesseron
