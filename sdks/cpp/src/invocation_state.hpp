#pragma once

#include <memory>
#include <mutex>
#include <optional>
#include <stop_token>
#include <string>

#include <tesseron/context.hpp>
#include <tesseron/protocol.hpp>

namespace tesseron::detail {

/// Everything one running invocation needs, shared by every copy of its
/// `ActionContext`.
///
/// The progress ceiling lives here rather than in the context so that two
/// copies handed to two helpers still cannot report a percentage below one the
/// agent has already rendered.
struct InvocationState {
  std::string action_name;
  std::string invocation_id;
  std::string origin;
  std::optional<std::string> route;
  AgentIdentity agent;
  Capabilities agent_capabilities;
  std::shared_ptr<GatewayChannel> channel;
  std::stop_source cancellation;

  std::mutex ceiling_guard;
  std::optional<int> highest_percent;
};

}  // namespace tesseron::detail
