use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use crate::context::GatewayChannel;
use crate::error::ActionError;
use crate::protocol::{ResourceDescriptor, ResourceUpdatedParams, methods};

type ReadFuture = Pin<Box<dyn Future<Output = Result<Value, ActionError>> + Send>>;

/// The erased form of a resource's read callback.
#[derive(Clone)]
pub(crate) struct ResourceReader {
    call: Arc<dyn Fn() -> ReadFuture + Send + Sync>,
}

impl ResourceReader {
    pub(crate) fn read(&self) -> ReadFuture {
        (self.call)()
    }
}

impl fmt::Debug for ResourceReader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ResourceReader")
    }
}

/// The handle a subscriber pushes new values through.
///
/// One emitter belongs to one `resources/subscribe`, so the subscription id is
/// already baked in. Cloning is cheap and every clone pushes to the same
/// subscriber, which is what lets a subscriber move it into a spawned task.
#[derive(Clone)]
pub struct ResourceEmitter {
    channel: Arc<dyn GatewayChannel>,
    subscription_id: String,
    active: Arc<AtomicBool>,
}

impl ResourceEmitter {
    pub(crate) fn new(channel: Arc<dyn GatewayChannel>, subscription_id: String) -> Self {
        Self {
            channel,
            subscription_id,
            active: Arc::new(AtomicBool::new(true)),
        }
    }

    pub(crate) fn active_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.active)
    }

    /// Pushes one new value to the subscribed agent. Fire-and-forget: a value
    /// emitted after the transport closed is dropped rather than queued.
    pub fn emit(&self, value: Value) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        let params = serde_json::to_value(ResourceUpdatedParams {
            subscription_id: self.subscription_id.clone(),
            value,
        })
        .unwrap_or(Value::Null);
        self.channel.notify(methods::UPDATED, params);
    }

    /// The gateway's id for this subscription.
    #[must_use]
    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }
}

impl fmt::Debug for ResourceEmitter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResourceEmitter")
            .field("subscription_id", &self.subscription_id)
            .finish_non_exhaustive()
    }
}

/// What a subscriber hands back so the SDK can stop pushing.
///
/// The teardown runs on `resources/unsubscribe` and again when the transport
/// closes, whichever comes first. A subscriber that leaks its listener here
/// keeps emitting into a session the agent already left.
pub struct Subscription {
    stop: Option<Box<dyn FnOnce() + Send>>,
    active: Option<Arc<AtomicBool>>,
}

impl Subscription {
    /// Runs `stop` when the agent unsubscribes or the session ends.
    #[must_use]
    pub fn new(stop: impl FnOnce() + Send + 'static) -> Self {
        Self {
            stop: Some(Box::new(stop)),
            active: None,
        }
    }

    /// For a subscriber that registered nothing needing teardown.
    #[must_use]
    pub const fn without_cleanup() -> Self {
        Self {
            stop: None,
            active: None,
        }
    }

    pub(crate) fn gate_emitter(mut self, active: Arc<AtomicBool>) -> Self {
        self.active = Some(active);
        self
    }

    pub(crate) fn stop(mut self) {
        if let Some(active) = self.active.take() {
            active.store(false, Ordering::Release);
        }
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

impl fmt::Debug for Subscription {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Subscription")
            .field("has_cleanup", &self.stop.is_some())
            .finish()
    }
}

/// The erased form of a resource's subscribe callback.
#[derive(Clone)]
pub(crate) struct ResourceSubscriber {
    call: Arc<dyn Fn(ResourceEmitter) -> Subscription + Send + Sync>,
}

impl ResourceSubscriber {
    pub(crate) fn subscribe(&self, emitter: ResourceEmitter) -> Subscription {
        (self.call)(emitter)
    }
}

impl fmt::Debug for ResourceSubscriber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ResourceSubscriber")
    }
}

/// One piece of application state the agent can read.
///
/// Reads are pulled: the reader runs on every `resources/read` and returns the
/// current value. Adding a subscriber with [`Resource::subscribe`] also lets the
/// agent ask to be pushed to, and is what declares the resource subscribable in
/// the manifest.
pub struct Resource {
    name: String,
    description: String,
    reader: ResourceReader,
    subscriber: Option<ResourceSubscriber>,
}

impl Resource {
    /// Registers a resource whose value is produced on demand.
    pub fn new<F, Fut>(name: impl Into<String>, read: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, ActionError>> + Send + 'static,
    {
        Self {
            name: name.into(),
            description: String::new(),
            reader: ResourceReader {
                call: Arc::new(move || Box::pin(read())),
            },
            subscriber: None,
        }
    }

    /// Sets the description the agent reads.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    /// Registers the callback that starts pushing updates, and declares the
    /// resource subscribable.
    ///
    /// The callback receives the emitter for one subscription and returns a
    /// [`Subscription`] carrying whatever teardown that registration needs.
    #[must_use]
    pub fn subscribe<F>(mut self, subscribe: F) -> Self
    where
        F: Fn(ResourceEmitter) -> Subscription + Send + Sync + 'static,
    {
        self.subscriber = Some(ResourceSubscriber {
            call: Arc::new(subscribe),
        });
        self
    }

    /// The registered name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        ResourceDescriptor,
        ResourceReader,
        Option<ResourceSubscriber>,
    ) {
        let descriptor = ResourceDescriptor {
            name: self.name,
            description: self.description,
            subscribable: self.subscriber.is_some(),
        };
        (descriptor, self.reader, self.subscriber)
    }
}

impl fmt::Debug for Resource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Resource")
            .field("name", &self.name)
            .field("subscribable", &self.subscriber.is_some())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::context::DetachedChannel;

    #[tokio::test]
    async fn a_resource_reads_its_current_value_on_every_call() {
        let resource = Resource::new("cart", || async { Ok(serde_json::json!({ "items": [] })) })
            .description("Current cart");
        let (descriptor, reader, subscriber) = resource.into_parts();
        assert_eq!(descriptor.name, "cart");
        assert_eq!(descriptor.description, "Current cart");
        assert!(
            !descriptor.subscribable,
            "a resource with no subscriber is not subscribable"
        );
        assert!(subscriber.is_none());
        assert_eq!(
            reader.read().await.unwrap(),
            serde_json::json!({ "items": [] })
        );
    }

    #[tokio::test]
    async fn registering_a_subscriber_declares_the_resource_subscribable() {
        let torn_down = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&torn_down);
        let resource =
            Resource::new("cart", || async { Ok(Value::Null) }).subscribe(move |_emitter| {
                let counter = Arc::clone(&counter);
                Subscription::new(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                })
            });
        let (descriptor, _reader, subscriber) = resource.into_parts();
        assert!(descriptor.subscribable);

        let emitter = ResourceEmitter::new(Arc::new(DetachedChannel), "sub-1".to_owned());
        let subscription = subscriber.unwrap().subscribe(emitter);
        subscription.stop();
        assert_eq!(torn_down.load(Ordering::Relaxed), 1);
    }
}
