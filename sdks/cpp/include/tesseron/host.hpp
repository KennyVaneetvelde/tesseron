#pragma once

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <tesseron/action.hpp>
#include <tesseron/context.hpp>
#include <tesseron/error.hpp>
#include <tesseron/json.hpp>
#include <tesseron/manifest.hpp>
#include <tesseron/protocol.hpp>
#include <tesseron/resource.hpp>
#include <tesseron/schema.hpp>

namespace tesseron {

namespace detail {
struct HostState;
}

/// Something the gateway did that the application may want to react to.
struct HostEvent {
  enum class Kind {
    /// The handshake succeeded. On a fresh session the welcome carries the
    /// claim code to show the user; on a resumed one it does not.
    Welcome,
    /// The user redeemed the claim code. Stop displaying it.
    Claimed,
    /// The gateway refused the handshake. A protocol major mismatch lands here.
    HandshakeFailed,
    /// The gateway connection ended. The host keeps listening.
    Disconnected,
  };

  Kind kind = Kind::Disconnected;
  std::optional<WelcomeResult> welcome;
  std::optional<ClaimedParams> claimed;
  std::optional<ProtocolError> handshake_failure;
};

/// Everything about the host that is not the application's own manifest.
struct HostOptions {
  /// Loopback only. Any other address is a `HostError` before a socket opens.
  std::string bind_address = "127.0.0.1";
  /// 0 asks the operating system for an ephemeral port, which is what an
  /// application wants: the manifest carries the real one.
  std::uint16_t port = 0;
  ManifestPublication manifest = ManifestPublication::default_directory();
  /// Where `ActionContext::on_application_thread` runs work.
  ///
  /// A user-interface toolkit that owns the main thread installs its own
  /// "post to the main loop" here. Left unset, that work runs inline on the
  /// host's I/O thread.
  std::function<void(std::function<void()>)> application_dispatcher;
};

class HostBuilder;

/// A listening application: one endpoint, one manifest, one gateway at a time.
class Host {
 public:
  /// Starts a host definition.
  [[nodiscard]] static HostBuilder builder();

  Host(Host&& other) noexcept;
  Host& operator=(Host&& other) noexcept;
  Host(const Host&) = delete;
  Host& operator=(const Host&) = delete;
  /// Shuts down if the application did not, so a dropped host never leaves its
  /// I/O thread running or its manifest behind.
  ~Host();

  /// The `ws://` URL the gateway dials. Also what the manifest advertises.
  [[nodiscard]] const std::string& url() const noexcept;
  /// The bound loopback address, useful when the port was ephemeral.
  [[nodiscard]] const std::string& local_address() const noexcept;
  /// The published manifest, or nothing when publication is disabled.
  [[nodiscard]] std::optional<std::filesystem::path> instance_manifest_path() const;
  /// The most recent welcome, with `tesseron/claimed` already applied, so a
  /// user interface can read the current claim code and agent at any time.
  [[nodiscard]] std::optional<WelcomeResult> welcome() const;

  /// Stops accepting, joins the I/O thread, then removes the instance
  /// manifest. Calling it twice is not an error.
  Result<void, HostError> shutdown();

 private:
  friend class HostBuilder;
  explicit Host(std::shared_ptr<detail::HostState> state);

  std::shared_ptr<detail::HostState> state_;
};

/// Collects one action's declaration. `handler` is the terminal step and hands
/// the host builder back so the chain continues.
class ActionBuilder {
 public:
  ActionBuilder& description(std::string description);
  /// Declares the input with the `Schema` builder: the same object publishes
  /// the manifest schema and enforces it at dispatch.
  ActionBuilder& input(Schema schema);
  /// The raw escape hatch, for a shape the `Schema` builder cannot express.
  /// The validator is not optional: an unenforced schema is a promise to the
  /// agent that the handler does not keep.
  ActionBuilder& input_schema(Json schema, InputValidator validator);
  /// Publishes a JSON Schema for the output. Informational: this library does
  /// not check handler output against it.
  ActionBuilder& output_schema(Json schema);
  /// Overrides the gateway's 60-second invocation timeout for this action.
  ActionBuilder& timeout(std::chrono::milliseconds timeout);

  HostBuilder& handler(ActionHandler handler);

 private:
  friend class HostBuilder;
  ActionBuilder(HostBuilder& owner, std::string name);

  HostBuilder* owner_;
  ActionDescriptor descriptor_;
  std::optional<InputValidator> validator_;
};

/// Collects one resource's declaration. `reader` is the terminal step, so
/// `description` and `subscribe` come before it.
class ResourceBuilder {
 public:
  ResourceBuilder& description(std::string description);
  /// Registers the callback that starts pushing updates, and declares the
  /// resource subscribable in the manifest.
  ResourceBuilder& subscribe(ResourceSubscriber subscriber);

  HostBuilder& reader(ResourceReader reader);

 private:
  friend class HostBuilder;
  ResourceBuilder(HostBuilder& owner, std::string name);

  HostBuilder* owner_;
  ResourceDescriptor descriptor_;
  std::optional<ResourceSubscriber> subscriber_;
};

/// Collects an application definition, then starts serving it.
///
/// ```cpp
/// auto host = tesseron::Host::builder()
///                 .application("todo", "Todo")
///                 .action("addTodo").input(add_todo_schema).handler(add_todo)
///                 .listen();
/// ```
class HostBuilder {
 public:
  HostBuilder();
  HostBuilder(HostBuilder&&) noexcept;
  HostBuilder& operator=(HostBuilder&&) noexcept;
  HostBuilder(const HostBuilder&) = delete;
  HostBuilder& operator=(const HostBuilder&) = delete;
  ~HostBuilder();

  /// Names the application. The id becomes the prefix on every MCP tool this
  /// application contributes, so it has to match `^[a-z][a-z0-9_]*$`.
  HostBuilder& application(std::string id, std::string name);
  /// Replaces the whole application descriptor, for the fields `application`
  /// does not take.
  HostBuilder& application_descriptor(ApplicationDescriptor application);
  HostBuilder& options(HostOptions options);
  /// Watches the session: welcome, claim, refusal, disconnect. The callback
  /// runs on the host's I/O thread.
  HostBuilder& on_event(std::function<void(const HostEvent&)> listener);

  [[nodiscard]] ActionBuilder action(std::string name);
  [[nodiscard]] ResourceBuilder resource(std::string name);

  /// Binds the loopback listener, publishes the manifest, and starts accepting
  /// the gateway on the host's own I/O thread.
  [[nodiscard]] Result<Host, HostError> listen();

 private:
  friend class ActionBuilder;
  friend class ResourceBuilder;

  struct Definition;

  std::unique_ptr<Definition> definition_;
};

}  // namespace tesseron
