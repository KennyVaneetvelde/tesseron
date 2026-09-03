use std::sync::Arc;

use tokio::sync::watch;

/// A cancellation signal shared between the session and one running handler.
///
/// The gateway cancels with a notification rather than a request, so nothing
/// answers `actions/cancel`; the invocation it names answers `-32001` instead.
/// A handler that ignores this signal still gets its answer replaced, but it
/// keeps burning the thread it was given, so long handlers should await
/// [`Cancellation::cancelled`] alongside their own work.
#[derive(Clone, Debug)]
pub struct Cancellation {
    state: Arc<watch::Sender<bool>>,
}

impl Cancellation {
    pub(crate) fn new() -> Self {
        let (sender, _receiver) = watch::channel(false);
        Self {
            state: Arc::new(sender),
        }
    }

    /// Records the cancellation.
    ///
    /// `send_replace` rather than `send`: `send` reports "no receivers" as an
    /// error and leaves the value alone, so a handler that never awaits
    /// [`Cancellation::cancelled`] would keep reading `false` forever.
    pub(crate) fn cancel(&self) {
        self.state.send_replace(true);
    }

    /// Whether cancellation has already been requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.state.borrow()
    }

    /// Resolves as soon as cancellation is requested, immediately if it already
    /// was.
    pub async fn cancelled(&self) {
        let mut receiver = self.state.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

/// What a handler is told about the invocation it is running.
///
/// Sampling, elicitation, and progress are not part of this release, so the
/// context carries identity and cancellation only. Handlers written against it
/// keep compiling when those arrive.
#[derive(Clone, Debug)]
pub struct ActionContext {
    action_name: String,
    invocation_id: String,
    cancellation: Cancellation,
}

impl ActionContext {
    pub(crate) fn new(
        action_name: String,
        invocation_id: String,
        cancellation: Cancellation,
    ) -> Self {
        Self {
            action_name,
            invocation_id,
            cancellation,
        }
    }

    /// The action being run.
    #[must_use]
    pub fn action_name(&self) -> &str {
        &self.action_name
    }

    /// The gateway's id for this invocation. Correlates progress, cancellation,
    /// and logs with the request the agent is waiting on.
    #[must_use]
    pub fn invocation_id(&self) -> &str {
        &self.invocation_id
    }

    /// The signal that fires when the agent cancels this invocation.
    #[must_use]
    pub const fn cancellation(&self) -> &Cancellation {
        &self.cancellation
    }

    /// Shorthand for [`Cancellation::is_cancelled`] on this invocation.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_resolves_for_a_signal_that_already_fired() {
        let cancellation = Cancellation::new();
        cancellation.cancel();
        assert!(cancellation.is_cancelled());
        cancellation.cancelled().await;
    }

    #[tokio::test]
    async fn cancelled_wakes_a_waiter_registered_before_the_signal() {
        let cancellation = Cancellation::new();
        let waiter = cancellation.clone();
        let task = tokio::spawn(async move { waiter.cancelled().await });
        tokio::task::yield_now().await;
        cancellation.cancel();
        task.await.unwrap();
    }
}
