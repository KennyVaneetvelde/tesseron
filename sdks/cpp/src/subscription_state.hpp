#pragma once

#include <atomic>
#include <memory>
#include <string>

#include <tesseron/context.hpp>

namespace tesseron::detail {

/// What one `resources/subscribe` leaves behind so its emitter can find the
/// connection and know whether the agent is still listening.
///
/// `active` is what makes "no update after unsubscribe" hold: the session
/// clears it on the I/O thread before it runs the subscriber's teardown, and an
/// emit already in flight re-reads it once it lands there.
struct SubscriptionState {
  std::weak_ptr<GatewayChannel> channel;
  std::string subscription_id;
  std::atomic<bool> active{true};
};

}  // namespace tesseron::detail
