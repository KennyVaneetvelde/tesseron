#pragma once

#include <atomic>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <boost/asio/executor_work_guard.hpp>
#include <boost/asio/io_context.hpp>
#include <boost/asio/ip/tcp.hpp>

#include <tesseron/action.hpp>
#include <tesseron/host.hpp>
#include <tesseron/json.hpp>
#include <tesseron/protocol.hpp>
#include <tesseron/resource.hpp>

namespace tesseron::detail {

class Session;

struct RegisteredAction {
  ActionDescriptor descriptor;
  std::optional<InputValidator> validator;
  ActionHandler handler;
};

struct RegisteredResource {
  ResourceDescriptor descriptor;
  ResourceReader reader;
  std::optional<ResourceSubscriber> subscriber;
};

/// Everything one host owns: what to announce, what to dispatch to, and what
/// the last welcome established.
///
/// One I/O thread runs every connection, so the registries and the connection
/// slot are read and written only from there. The negotiation snapshot is the
/// exception, because `Host::welcome` answers on whatever thread the
/// application asks from.
struct HostState {
  ApplicationDescriptor application;
  Capabilities capabilities = Capabilities::implemented();
  std::map<std::string, RegisteredAction> actions;
  std::vector<std::string> action_order;
  std::map<std::string, RegisteredResource> resources;
  std::vector<std::string> resource_order;
  std::function<void(const HostEvent&)> listener;
  std::function<void(std::function<void()>)> application_dispatcher;

  boost::asio::io_context io_context{1};
  boost::asio::executor_work_guard<boost::asio::io_context::executor_type> work_guard{
      boost::asio::make_work_guard(io_context)};
  std::optional<boost::asio::ip::tcp::acceptor> acceptor;
  std::thread io_thread;
  std::string url;
  std::string local_address;
  std::optional<std::filesystem::path> manifest_path;
  std::weak_ptr<Session> connection;
  std::atomic<bool> shut_down{false};

  /// Manifest entries keep registration order so the agent sees a stable list
  /// across restarts rather than whatever order the map iterates in.
  [[nodiscard]] Json action_descriptors() const;
  [[nodiscard]] Json resource_descriptors() const;
  [[nodiscard]] Json hello_params() const;
  [[nodiscard]] Json resume_params(const std::string& session_id,
                                   const std::string& resume_token) const;

  /// The credentials for the next `tesseron/resume`, if the last welcome issued
  /// any.
  ///
  /// They live in memory only. A restarted process is a new session by design:
  /// persisting a bearer token to disk would hand a resumable claimed session
  /// to anything that can read the file.
  [[nodiscard]] std::optional<std::pair<std::string, std::string>> resume_credentials() const;

  /// Drops the whole negotiated session, not just its token. A gateway that
  /// refuses a resume has forgotten the session, so keeping the welcome would
  /// leave handlers negotiating against capabilities nobody agreed to.
  void forget_session();

  void record_welcome(const WelcomeResult& welcome);
  void record_claim(const ClaimedParams& claimed);

  [[nodiscard]] std::optional<WelcomeResult> welcome_snapshot() const;
  [[nodiscard]] Capabilities negotiated_capabilities() const;
  [[nodiscard]] AgentIdentity agent_identity() const;

  void emit(const HostEvent& event) const;

 private:
  mutable std::mutex negotiation_guard_;
  std::optional<WelcomeResult> welcome_;
  std::optional<std::pair<std::string, std::string>> resume_;
};

}  // namespace tesseron::detail
