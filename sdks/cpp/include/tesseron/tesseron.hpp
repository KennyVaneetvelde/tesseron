#pragma once

/// The whole public surface of the Tesseron C++ SDK.
///
/// A Tesseron application hosts a loopback endpoint and publishes an instance
/// manifest; the MCP gateway discovers that manifest and dials *in*. This
/// library owns the application half of that contract: the wire types, the
/// JSON-RPC correlation, the WebSocket listener, the manifest, and the
/// handshake that turns a fresh socket into a claimed session.

#include <tesseron/action.hpp>
#include <tesseron/context.hpp>
#include <tesseron/error.hpp>
#include <tesseron/host.hpp>
#include <tesseron/json.hpp>
#include <tesseron/manifest.hpp>
#include <tesseron/protocol.hpp>
#include <tesseron/resource.hpp>
#include <tesseron/schema.hpp>
