use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::error::ActionError;
use crate::protocol::ResourceDescriptor;

type ReadFuture = Pin<Box<dyn Future<Output = Result<Value, ActionError>> + Send>>;

/// The erased form of a resource's read callback.
#[derive(Clone)]
pub struct ResourceReader {
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

/// One piece of application state the agent can read.
///
/// Resources are pulled, not pushed: the reader runs on every `resources/read`
/// and returns the current value. Marking a resource
/// [`subscribable`](Resource::subscribable) advertises it in the manifest, but
/// pushed updates arrive with the `subscriptions` capability, which this
/// release does not implement.
pub struct Resource {
    name: String,
    description: String,
    subscribable: bool,
    reader: ResourceReader,
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
            subscribable: false,
            reader: ResourceReader {
                call: Arc::new(move || Box::pin(read())),
            },
        }
    }

    /// Sets the description the agent reads.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    /// Declares whether the agent may subscribe for pushed updates.
    #[must_use]
    pub const fn subscribable(mut self, subscribable: bool) -> Self {
        self.subscribable = subscribable;
        self
    }

    /// The registered name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn into_parts(self) -> (ResourceDescriptor, ResourceReader) {
        let descriptor = ResourceDescriptor {
            name: self.name,
            description: self.description,
            subscribable: self.subscribable,
        };
        (descriptor, self.reader)
    }
}

impl fmt::Debug for Resource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Resource")
            .field("name", &self.name)
            .field("subscribable", &self.subscribable)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_resource_reads_its_current_value_on_every_call() {
        let resource = Resource::new("cart", || async { Ok(serde_json::json!({ "items": [] })) })
            .description("Current cart")
            .subscribable(true);
        let (descriptor, reader) = resource.into_parts();
        assert_eq!(descriptor.name, "cart");
        assert_eq!(descriptor.description, "Current cart");
        assert!(descriptor.subscribable);
        assert_eq!(
            reader.read().await.unwrap(),
            serde_json::json!({ "items": [] })
        );
    }
}
