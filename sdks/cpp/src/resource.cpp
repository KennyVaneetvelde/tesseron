#include <tesseron/resource.hpp>

#include <utility>

#include <boost/asio/post.hpp>

#include <tesseron/protocol.hpp>

#include "subscription_state.hpp"

namespace tesseron {

ResourceEmitter::ResourceEmitter(std::shared_ptr<detail::SubscriptionState> state)
    : state_(std::move(state)) {}

void ResourceEmitter::emit(Json value) const {
  if (!state_) return;
  const auto channel = state_->channel.lock();
  if (!channel) return;

  // Hopping onto the connection's own thread is what makes this callable from
  // wherever the application's data actually changes, and it is also where the
  // subscription's liveness can be read without racing an unsubscribe.
  boost::asio::post(channel->executor(),
                    [state = state_, channel, value = std::move(value)]() mutable {
                      if (!state->active.load(std::memory_order_acquire)) return;
                      Json params = Json::object();
                      params["subscriptionId"] = state->subscription_id;
                      params["value"] = std::move(value);
                      channel->notify(std::string(methods::kUpdated), std::move(params));
                    });
}

const std::string& ResourceEmitter::subscription_id() const noexcept {
  return state_->subscription_id;
}

Subscription Subscription::with_teardown(std::function<void()> teardown) {
  Subscription subscription;
  subscription.teardown_ = std::move(teardown);
  return subscription;
}

Subscription Subscription::without_teardown() { return {}; }

void Subscription::stop() {
  if (!teardown_) return;
  auto teardown = std::move(teardown_);
  teardown_ = nullptr;
  teardown();
}

}  // namespace tesseron
