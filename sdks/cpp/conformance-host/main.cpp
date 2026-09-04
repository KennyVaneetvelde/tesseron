/// Host adapter for the `@tesseron/conformance` runner.
///
/// The runner starts one of these per fixture with `TESSERON_CONFORMANCE_FIXTURE`
/// pointing at the fixture document, waits for a single readiness line on
/// stdout, then plays the gateway against the endpoint that line names. Every
/// diagnostic goes to stderr, because a second stdout line fails the fixture.

#include <csignal>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include <tesseron/host.hpp>

#include "fixture.hpp"

namespace {

constexpr const char* kFixturePathVariable = "TESSERON_CONFORMANCE_FIXTURE";

std::optional<std::string> read_environment(const char* name) {
#ifdef _WIN32
  char* value = nullptr;
  std::size_t length = 0;
  if (::_dupenv_s(&value, &length, name) != 0 || value == nullptr) return std::nullopt;
  std::string copied(value);
  std::free(value);
  if (copied.empty()) return std::nullopt;
  return copied;
#else
  const char* const value = std::getenv(name);
  if (value == nullptr || *value == '\0') return std::nullopt;
  return std::string(value);
#endif
}

tesseron::ApplicationDescriptor conformance_application() {
  tesseron::ApplicationDescriptor application;
  application.id = "conformance";
  application.name = "Tesseron C++ conformance host";
  application.origin = "tesseron-conformance://cpp";
  return application;
}

/// Waits for the runner to ask the process to end.
///
/// Closing stdin is the runner's normal signal. Windows has no SIGTERM and the
/// runner's force-kill path ends the process outright, so stdin is the only
/// orderly route on either platform; the interrupt handler is there for a
/// developer running the binary by hand.
void wait_for_shutdown() {
  std::string discarded;
  while (std::getline(std::cin, discarded)) {
  }
}

void end_on_interrupt(int) { std::_Exit(EXIT_SUCCESS); }

int run() {
  const auto fixture_path = read_environment(kFixturePathVariable);
  if (!fixture_path.has_value()) {
    std::cerr << "tesseron-conformance-host: " << kFixturePathVariable << " is required\n";
    return EXIT_FAILURE;
  }

  std::ifstream document(*fixture_path, std::ios::binary);
  if (!document) {
    std::cerr << "tesseron-conformance-host: could not read " << *fixture_path << "\n";
    return EXIT_FAILURE;
  }
  std::ostringstream contents;
  contents << document.rdbuf();

  tesseron::Json fixture = tesseron::Json::parse(contents.str(), nullptr, false);
  if (fixture.is_discarded()) {
    std::cerr << "tesseron-conformance-host: " << *fixture_path << " is not valid JSON\n";
    return EXIT_FAILURE;
  }

  tesseron::HostOptions options;
  // The runner dials the endpoint it is told about and never reads discovery
  // manifests, so publishing one would only litter ~/.tesseron/instances.
  options.manifest = tesseron::ManifestPublication::disabled();

  auto builder = tesseron::Host::builder();
  builder.application_descriptor(conformance_application());
  builder.options(std::move(options));
  if (const auto refusal = conformance::register_fixture(builder, fixture)) {
    std::cerr << "tesseron-conformance-host: " << *refusal << "\n";
    return EXIT_FAILURE;
  }

  auto listening = builder.listen();
  if (!listening.ok()) {
    std::cerr << "tesseron-conformance-host: " << listening.error().message() << "\n";
    return EXIT_FAILURE;
  }
  auto host = std::move(listening).value();

  // Flushed rather than left in a buffer, or the runner times out waiting for
  // a line the process has already written.
  std::cout << "tesseron-conformance-url=" << host.url() << std::endl;

  wait_for_shutdown();

  if (const auto stopping = host.shutdown(); !stopping.ok()) {
    std::cerr << "tesseron-conformance-host: " << stopping.error().message() << "\n";
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}

}  // namespace

int main() {
  std::signal(SIGINT, end_on_interrupt);
#ifdef SIGTERM
  std::signal(SIGTERM, end_on_interrupt);
#endif
  return run();
}
