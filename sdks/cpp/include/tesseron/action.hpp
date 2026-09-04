#pragma once

#include <functional>
#include <vector>

#include <boost/asio/awaitable.hpp>

#include <tesseron/context.hpp>
#include <tesseron/error.hpp>
#include <tesseron/json.hpp>
#include <tesseron/schema.hpp>

namespace tesseron {

/// What an action handler is: JSON in, a result or a failure out, cancellable
/// through the context's stop token.
///
/// The coroutine runs on the host's own I/O thread, so `co_await` on a sample
/// or an elicitation yields instead of blocking the read loop.
using ActionHandler = std::function<boost::asio::awaitable<Result<Json>>(Json, ActionContext)>;

/// The runtime check applied to `actions/invoke` input before the handler runs.
///
/// An action declared with a `Schema` gets one for free. An action declared
/// with a raw `nlohmann::json` schema supplies its own, because a schema
/// nothing enforces is a promise to the agent that the handler does not keep.
using InputValidator = std::function<std::vector<ValidationIssue>(const Json&)>;

}  // namespace tesseron
