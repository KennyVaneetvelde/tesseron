#pragma once

#include <functional>
#include <memory>
#include <string>

#include <boost/asio/awaitable.hpp>

#include <tesseron/error.hpp>
#include <tesseron/json.hpp>

namespace tesseron {

namespace detail {
struct SubscriptionState;
}

/// How a resource produces its current value. Runs on every `resources/read`.
using ResourceReader = std::function<boost::asio::awaitable<Result<Json>>()>;

/// The handle a subscriber pushes new values through.
///
/// One emitter belongs to one `resources/subscribe`, so the subscription id is
/// already baked in. Copying is cheap and every copy pushes to the same
/// subscriber, which is what lets a subscriber hand it to another thread.
class ResourceEmitter {
 public:
  explicit ResourceEmitter(std::shared_ptr<detail::SubscriptionState> state);

  /// Pushes one new value to the subscribed agent.
  ///
  /// Safe from any thread. Fire-and-forget: a value emitted after the agent
  /// unsubscribed, or after the transport closed, is dropped rather than
  /// queued.
  void emit(Json value) const;

  [[nodiscard]] const std::string& subscription_id() const noexcept;

 private:
  std::shared_ptr<detail::SubscriptionState> state_;
};

/// What a subscriber hands back so the SDK can stop pushing.
///
/// The teardown runs on `resources/unsubscribe` and again when the transport
/// closes, whichever comes first. A subscriber that leaks its listener here
/// keeps emitting into a session the agent already left.
class Subscription {
 public:
  /// Runs `teardown` when the agent unsubscribes or the session ends.
  [[nodiscard]] static Subscription with_teardown(std::function<void()> teardown);
  /// For a subscriber that registered nothing needing teardown.
  [[nodiscard]] static Subscription without_teardown();

  void stop();

 private:
  Subscription() = default;

  std::function<void()> teardown_;
};

/// How a resource starts pushing. Registering one declares the resource
/// subscribable in the manifest.
using ResourceSubscriber = std::function<Subscription(ResourceEmitter)>;

}  // namespace tesseron
