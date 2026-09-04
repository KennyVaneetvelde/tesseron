# Catch2 arrives the same way every other dependency does: FetchContent at a
# pinned version and hash. It is declared here rather than in
# TesseronDependencies so a consumer building the library alone never fetches a
# test framework.
include(FetchContent)

set(TESSERON_CATCH2_VERSION "3.8.1")
set(TESSERON_CATCH2_SHA256 "18b3f70ac80fccc340d8c6ff0f339b2ae64944782f8d2fca2bd705cf47cadb79")

set(CATCH_INSTALL_DOCS OFF CACHE BOOL "" FORCE)
set(CATCH_INSTALL_EXTRAS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  Catch2
  URL "https://github.com/catchorg/Catch2/archive/refs/tags/v${TESSERON_CATCH2_VERSION}.tar.gz"
  URL_HASH "SHA256=${TESSERON_CATCH2_SHA256}"
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(Catch2)

list(APPEND CMAKE_MODULE_PATH "${catch2_SOURCE_DIR}/extras")
include(Catch)

add_executable(
  tesseron-tests
  error_mapping_test.cpp
  framing_test.cpp
  gateway_double.cpp
  handshake_test.cpp
  progress_test.cpp
  subscription_test.cpp)

target_link_libraries(tesseron-tests PRIVATE tesseron::tesseron Catch2::Catch2WithMain
                                             Boost::beast)
target_compile_features(tesseron-tests PRIVATE cxx_std_20)

# The framing, handshake and progress tests reach into the library's own
# headers. That is deliberate: those pieces have no public surface, and testing
# them only through the socket would leave the state machine's edges uncovered.
target_include_directories(tesseron-tests PRIVATE "${CMAKE_CURRENT_LIST_DIR}/../src")

if(MSVC)
  target_compile_options(tesseron-tests PRIVATE /bigobj)
endif()

catch_discover_tests(tesseron-tests)
