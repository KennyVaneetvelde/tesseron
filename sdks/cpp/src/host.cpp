#include <tesseron/host.hpp>

#include <chrono>
#include <iostream>
#include <sstream>
#include <string_view>
#include <utility>

#include <boost/asio/co_spawn.hpp>
#include <boost/asio/detached.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/redirect_error.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/asio/this_coro.hpp>
#include <boost/asio/use_awaitable.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include "host_state.hpp"
#include "manifest_store.hpp"
#include "session.hpp"

namespace tesseron {
namespace {

using boost::asio::awaitable;
using boost::asio::redirect_error;
using boost::asio::use_awaitable;

/// Pause after a failed accept, so a descriptor limit or a transient kernel
/// refusal cannot turn the accept loop into a busy loop that burns a core.
constexpr std::chrono::milliseconds kAcceptRetryDelay{50};

/// How long a dialer has to finish its upgrade before the host hangs up.
constexpr std::chrono::seconds kUpgradeTimeout{30};

std::string describe(const boost::asio::ip::tcp::endpoint& endpoint) {
  std::ostringstream description;
  description << endpoint;
  return description.str();
}

std::string_view trimmed(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
  return text;
}

bool offers_gateway_subprotocol(
    const boost::beast::http::request<boost::beast::http::string_body>& upgrade) {
  const auto offered = upgrade.equal_range(boost::beast::http::field::sec_websocket_protocol);
  for (auto header = offered.first; header != offered.second; ++header) {
    std::string_view remaining(header->value().data(), header->value().size());
    while (!remaining.empty()) {
      const auto separator = remaining.find(',');
      const auto candidate = trimmed(remaining.substr(0, separator));
      if (candidate == kGatewaySubprotocol) return true;
      if (separator == std::string_view::npos) break;
      remaining.remove_prefix(separator + 1);
    }
  }
  return false;
}

/// Completes the WebSocket upgrade, insisting on the gateway subprotocol.
///
/// The endpoint exists for the gateway. Anything else on the machine that finds
/// the port gets a 400 rather than a session.
awaitable<void> serve_gateway_connection(boost::asio::ip::tcp::socket socket,
                                         std::shared_ptr<detail::HostState> host) {
  boost::beast::tcp_stream stream(std::move(socket));
  stream.expires_after(kUpgradeTimeout);

  boost::beast::flat_buffer buffer;
  boost::beast::http::request<boost::beast::http::string_body> upgrade;
  boost::system::error_code failure;
  co_await boost::beast::http::async_read(stream, buffer, upgrade,
                                          redirect_error(use_awaitable, failure));
  if (failure) co_return;

  if (!boost::beast::websocket::is_upgrade(upgrade) || !offers_gateway_subprotocol(upgrade)) {
    boost::beast::http::response<boost::beast::http::string_body> rejection(
        boost::beast::http::status::bad_request, upgrade.version());
    rejection.set(boost::beast::http::field::content_type, "text/plain");
    rejection.body() =
        "this endpoint requires the " + std::string(kGatewaySubprotocol) + " subprotocol";
    rejection.prepare_payload();
    co_await boost::beast::http::async_write(stream, rejection,
                                             redirect_error(use_awaitable, failure));
    std::cerr << "tesseron: refused a WebSocket upgrade without the " << kGatewaySubprotocol
              << " subprotocol\n";
    co_return;
  }

  detail::WebSocketStream websocket(std::move(stream));
  websocket.set_option(boost::beast::websocket::stream_base::timeout::suggested(
      boost::beast::role_type::server));
  websocket.set_option(boost::beast::websocket::stream_base::decorator(
      [](boost::beast::websocket::response_type& response) {
        response.set(boost::beast::http::field::sec_websocket_protocol,
                     std::string(kGatewaySubprotocol));
      }));
  co_await websocket.async_accept(upgrade, redirect_error(use_awaitable, failure));
  if (failure) co_return;
  websocket.text(true);

  co_await detail::Session::serve(std::move(websocket), std::move(host));
}

awaitable<void> accept_gateway_connections(std::shared_ptr<detail::HostState> host) {
  while (true) {
    boost::system::error_code failure;
    auto socket = co_await host->acceptor->async_accept(redirect_error(use_awaitable, failure));
    if (failure) {
      if (failure == boost::asio::error::operation_aborted) break;
      std::cerr << "tesseron: could not accept a connection: " << failure.message() << '\n';
      boost::asio::steady_timer pause(co_await boost::asio::this_coro::executor);
      pause.expires_after(kAcceptRetryDelay);
      boost::system::error_code ignored;
      co_await pause.async_wait(redirect_error(use_awaitable, ignored));
      continue;
    }
    // Serving inline is the single-connection-per-session rule: a second dial
    // waits in the accept queue instead of racing the handshake of the first.
    co_await serve_gateway_connection(std::move(socket), host);
  }
}

}  // namespace

namespace detail {

Json HostState::action_descriptors() const {
  Json descriptors = Json::array();
  for (const auto& name : action_order) {
    const auto action = actions.find(name);
    if (action != actions.end()) descriptors.push_back(action->second.descriptor.to_json());
  }
  return descriptors;
}

Json HostState::resource_descriptors() const {
  Json descriptors = Json::array();
  for (const auto& name : resource_order) {
    const auto resource = resources.find(name);
    if (resource != resources.end()) descriptors.push_back(resource->second.descriptor.to_json());
  }
  return descriptors;
}

Json HostState::hello_params() const {
  Json params = Json::object();
  params["protocolVersion"] = std::string(kProtocolVersion);
  params["app"] = application.to_json();
  params["actions"] = action_descriptors();
  params["resources"] = resource_descriptors();
  params["capabilities"] = capabilities.to_json();
  return params;
}

Json HostState::resume_params(const std::string& session_id,
                              const std::string& resume_token) const {
  // The manifest repeats because a restarted application may have added,
  // removed, or changed actions since the session was claimed; the gateway
  // replaces its stored copy with whatever resume brings in.
  Json params = hello_params();
  params["sessionId"] = session_id;
  params["resumeToken"] = resume_token;
  return params;
}

std::optional<std::pair<std::string, std::string>> HostState::resume_credentials() const {
  const std::lock_guard<std::mutex> guard(negotiation_guard_);
  return resume_;
}

void HostState::forget_session() {
  const std::lock_guard<std::mutex> guard(negotiation_guard_);
  resume_.reset();
  welcome_.reset();
}

void HostState::record_welcome(const WelcomeResult& welcome) {
  const std::lock_guard<std::mutex> guard(negotiation_guard_);
  welcome_ = welcome;
  // Resume tokens are one-shot, so the freshest welcome is always the one to
  // keep; a welcome without a token means this session cannot be resumed.
  if (welcome.resume_token.has_value()) {
    resume_ = std::pair(welcome.session_id, *welcome.resume_token);
  } else {
    resume_.reset();
  }
}

void HostState::record_claim(const ClaimedParams& claimed) {
  const std::lock_guard<std::mutex> guard(negotiation_guard_);
  if (!welcome_.has_value()) return;
  welcome_->agent = claimed.agent;
  // The claim code has been spent, so anything rendering it has to stop.
  welcome_->claim_code.reset();
  if (claimed.agent_capabilities.has_value()) {
    welcome_->capabilities = Capabilities::from_json(*claimed.agent_capabilities);
  }
}

std::optional<WelcomeResult> HostState::welcome_snapshot() const {
  const std::lock_guard<std::mutex> guard(negotiation_guard_);
  return welcome_;
}

Capabilities HostState::negotiated_capabilities() const {
  const auto welcome = welcome_snapshot();
  return welcome.has_value() ? welcome->capabilities : Capabilities::none();
}

AgentIdentity HostState::agent_identity() const {
  const auto welcome = welcome_snapshot();
  return welcome.has_value() ? welcome->agent : AgentIdentity{};
}

void HostState::emit(const HostEvent& event) const {
  if (!listener) return;
  try {
    listener(event);
  } catch (const std::exception& problem) {
    std::cerr << "tesseron: a host event listener threw: " << problem.what() << '\n';
  } catch (...) {
    std::cerr << "tesseron: a host event listener threw a value that is not an exception\n";
  }
}

}  // namespace detail

struct HostBuilder::Definition {
  std::optional<ApplicationDescriptor> application;
  HostOptions options;
  std::function<void(const HostEvent&)> listener;
  std::vector<detail::RegisteredAction> actions;
  std::vector<detail::RegisteredResource> resources;
};

HostBuilder::HostBuilder() : definition_(std::make_unique<Definition>()) {}
HostBuilder::HostBuilder(HostBuilder&&) noexcept = default;
HostBuilder& HostBuilder::operator=(HostBuilder&&) noexcept = default;
HostBuilder::~HostBuilder() = default;

HostBuilder Host::builder() { return {}; }

HostBuilder& HostBuilder::application(std::string id, std::string name) {
  ApplicationDescriptor application;
  application.id = std::move(id);
  application.name = std::move(name);
  definition_->application = std::move(application);
  return *this;
}

HostBuilder& HostBuilder::application_descriptor(ApplicationDescriptor application) {
  definition_->application = std::move(application);
  return *this;
}

HostBuilder& HostBuilder::options(HostOptions options) {
  definition_->options = std::move(options);
  return *this;
}

HostBuilder& HostBuilder::on_event(std::function<void(const HostEvent&)> listener) {
  definition_->listener = std::move(listener);
  return *this;
}

ActionBuilder HostBuilder::action(std::string name) { return {*this, std::move(name)}; }

ResourceBuilder HostBuilder::resource(std::string name) { return {*this, std::move(name)}; }

ActionBuilder::ActionBuilder(HostBuilder& owner, std::string name) : owner_(&owner) {
  descriptor_.name = std::move(name);
}

ActionBuilder& ActionBuilder::description(std::string description) {
  descriptor_.description = std::move(description);
  return *this;
}

ActionBuilder& ActionBuilder::input(Schema schema) {
  descriptor_.input_schema = schema.to_json();
  validator_ = [schema = std::move(schema)](const Json& input) { return schema.validate(input); };
  return *this;
}

ActionBuilder& ActionBuilder::input_schema(Json schema, InputValidator validator) {
  descriptor_.input_schema = std::move(schema);
  validator_ = std::move(validator);
  return *this;
}

ActionBuilder& ActionBuilder::output_schema(Json schema) {
  descriptor_.output_schema = std::move(schema);
  return *this;
}

ActionBuilder& ActionBuilder::timeout(std::chrono::milliseconds timeout) {
  descriptor_.timeout_milliseconds = static_cast<std::uint64_t>(timeout.count());
  return *this;
}

HostBuilder& ActionBuilder::handler(ActionHandler handler) {
  owner_->definition_->actions.push_back(
      detail::RegisteredAction{std::move(descriptor_), std::move(validator_), std::move(handler)});
  return *owner_;
}

ResourceBuilder::ResourceBuilder(HostBuilder& owner, std::string name) : owner_(&owner) {
  descriptor_.name = std::move(name);
}

ResourceBuilder& ResourceBuilder::description(std::string description) {
  descriptor_.description = std::move(description);
  return *this;
}

ResourceBuilder& ResourceBuilder::subscribe(ResourceSubscriber subscriber) {
  descriptor_.subscribable = true;
  subscriber_ = std::move(subscriber);
  return *this;
}

HostBuilder& ResourceBuilder::reader(ResourceReader reader) {
  owner_->definition_->resources.push_back(detail::RegisteredResource{
      std::move(descriptor_), std::move(reader), std::move(subscriber_)});
  return *owner_;
}

Result<Host, HostError> HostBuilder::listen() {
  if (!definition_->application.has_value()) {
    return HostError(HostError::Kind::MissingApplication,
                     "a host needs an application descriptor before it can listen");
  }
  const auto& application = *definition_->application;
  if (!is_valid_application_id(application.id)) {
    return HostError(HostError::Kind::InvalidApplicationId,
                     "application id \"" + application.id +
                         "\" must match ^[a-z][a-z0-9_]*$ and must not be tesseron, mcp, or system");
  }

  const auto& options = definition_->options;
  if (!is_loopback_address(options.bind_address)) {
    return HostError(HostError::Kind::NonLoopbackBindAddress,
                     "bind address \"" + options.bind_address +
                         "\" is not loopback; Tesseron's threat model is same-host, same-user");
  }

  auto state = std::make_shared<detail::HostState>();
  state->application = application;
  state->listener = definition_->listener;
  state->application_dispatcher = options.application_dispatcher;

  for (auto& action : definition_->actions) {
    const auto name = action.descriptor.name;
    if (state->actions.count(name) != 0) {
      return HostError(HostError::Kind::DuplicateName, "two actions are named \"" + name + "\"");
    }
    state->action_order.push_back(name);
    state->actions.emplace(name, std::move(action));
  }
  for (auto& resource : definition_->resources) {
    const auto name = resource.descriptor.name;
    if (state->resources.count(name) != 0) {
      return HostError(HostError::Kind::DuplicateName, "two resources are named \"" + name + "\"");
    }
    state->resource_order.push_back(name);
    state->resources.emplace(name, std::move(resource));
  }

  boost::system::error_code failure;
  const auto address = boost::asio::ip::make_address(options.bind_address, failure);
  if (failure) {
    return HostError(HostError::Kind::NonLoopbackBindAddress,
                     "bind address \"" + options.bind_address + "\" is not an address literal");
  }

  const boost::asio::ip::tcp::endpoint endpoint(address, options.port);
  state->acceptor.emplace(state->io_context);
  state->acceptor->open(endpoint.protocol(), failure);
  if (failure) return HostError(HostError::Kind::Listen, "could not open a listener: " + failure.message());
  state->acceptor->set_option(boost::asio::ip::tcp::acceptor::reuse_address(true), failure);
  state->acceptor->bind(endpoint, failure);
  if (failure) {
    return HostError(HostError::Kind::Listen,
                     "could not bind " + describe(endpoint) + ": " + failure.message());
  }
  state->acceptor->listen(boost::asio::socket_base::max_listen_connections, failure);
  if (failure) {
    return HostError(HostError::Kind::Listen, "could not listen: " + failure.message());
  }

  const auto bound = state->acceptor->local_endpoint(failure);
  if (failure) {
    return HostError(HostError::Kind::Listen,
                     "could not read the bound address: " + failure.message());
  }
  state->local_address = describe(bound);
  state->url = "ws://" + state->local_address + "/";

  if (options.manifest.mode() != ManifestPublication::Mode::Disabled) {
    std::filesystem::path directory = options.manifest.path();
    if (options.manifest.mode() == ManifestPublication::Mode::DefaultDirectory) {
      auto resolved = detail::default_instance_directory();
      if (!resolved.ok()) return std::move(resolved).error();
      directory = std::move(resolved).value();
    }
    auto published = detail::publish_manifest(
        InstanceManifest::for_websocket(detail::mint_instance_id(), application.name, state->url),
        directory);
    if (!published.ok()) return std::move(published).error();
    state->manifest_path = std::move(published).value();
  }

  boost::asio::co_spawn(state->io_context, accept_gateway_connections(state),
                        boost::asio::detached);
  state->io_thread = std::thread([state] {
    try {
      state->io_context.run();
    } catch (const std::exception& problem) {
      std::cerr << "tesseron: the host I/O thread stopped: " << problem.what() << '\n';
    } catch (...) {
      std::cerr << "tesseron: the host I/O thread stopped on a value that is not an exception\n";
    }
  });

  return Host(std::move(state));
}

Host::Host(std::shared_ptr<detail::HostState> state) : state_(std::move(state)) {}

Host::Host(Host&& other) noexcept = default;

Host& Host::operator=(Host&& other) noexcept {
  if (this == &other) return *this;
  try {
    if (state_) (void)shutdown();
  } catch (...) {
  }
  state_ = std::move(other.state_);
  return *this;
}

Host::~Host() {
  try {
    if (state_) (void)shutdown();
  } catch (...) {
  }
}

const std::string& Host::url() const noexcept { return state_->url; }

const std::string& Host::local_address() const noexcept { return state_->local_address; }

std::optional<std::filesystem::path> Host::instance_manifest_path() const {
  return state_->manifest_path;
}

std::optional<WelcomeResult> Host::welcome() const { return state_->welcome_snapshot(); }

Result<void, HostError> Host::shutdown() {
  if (!state_) return Result<void, HostError>::success();
  if (state_->shut_down.exchange(true)) return Result<void, HostError>::success();

  boost::asio::post(state_->io_context, [state = state_] {
    boost::system::error_code ignored;
    if (state->acceptor.has_value()) state->acceptor->close(ignored);
    if (const auto connection = state->connection.lock()) connection->close();
  });
  state_->work_guard.reset();
  if (state_->io_thread.joinable()) state_->io_thread.join();

  if (!state_->manifest_path.has_value()) return Result<void, HostError>::success();
  return detail::withdraw_manifest(*state_->manifest_path);
}

}  // namespace tesseron
