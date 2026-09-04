cmake_minimum_required(VERSION 3.24)

project(
  tesseron
  VERSION 0.1.0
  DESCRIPTION "C++ SDK for the Tesseron protocol"
  LANGUAGES CXX)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/cmake")

option(TESSERON_BUILD_TESTS "Build the Catch2 test suite" OFF)
option(TESSERON_BUILD_CONFORMANCE_HOST "Build the private conformance host adapter" OFF)
option(TESSERON_BUILD_EXAMPLES "Build the canonical headless examples" OFF)
option(TESSERON_INSTALL "Generate install and export rules" ${PROJECT_IS_TOP_LEVEL})

include(TesseronDependencies)

# A host owns the thread its I/O context runs on, and libstdc++ leaves the
# pthread symbols behind that to the linker rather than pulling them in itself.
find_package(Threads REQUIRED)

add_library(
  tesseron
  src/context.cpp
  src/elicit_schema.cpp
  src/error.cpp
  src/host.cpp
  src/jsonrpc.cpp
  src/manifest.cpp
  src/protocol.cpp
  src/resource.cpp
  src/schema.cpp
  src/session.cpp)
add_library(tesseron::tesseron ALIAS tesseron)

target_compile_features(tesseron PUBLIC cxx_std_20)
target_include_directories(
  tesseron
  PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_LIST_DIR}/include>
         $<INSTALL_INTERFACE:include>
  PRIVATE ${CMAKE_CURRENT_LIST_DIR}/src)

# The dependency names are wrapped in BUILD_INTERFACE so the export set does not
# have to carry FetchContent targets it cannot own. The installed package config
# resolves the same names through find_dependency instead.
target_link_libraries(
  tesseron
  PUBLIC $<BUILD_INTERFACE:Boost::asio> $<BUILD_INTERFACE:nlohmann_json::nlohmann_json>
         Threads::Threads
  PRIVATE $<BUILD_INTERFACE:Boost::beast>)

if(WIN32)
  # Asio reads _WIN32_WINNT to pick its I/O completion API, and it has to be set
  # before any Asio header is included, in this target and in every consumer.
  target_compile_definitions(tesseron PUBLIC _WIN32_WINNT=0x0A00 WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(tesseron PUBLIC ws2_32 mswsock)
endif()

if(MSVC)
  # /bigobj: Beast's templates blow past the default section limit.
  # /Zc:__cplusplus: without it MSVC reports C++98 and header feature checks
  # fall back to pre-C++20 paths.
  target_compile_options(tesseron PUBLIC /bigobj /Zc:__cplusplus /permissive-)
endif()

if(TESSERON_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()

if(TESSERON_BUILD_CONFORMANCE_HOST)
  add_subdirectory(conformance-host)
endif()

if(TESSERON_BUILD_EXAMPLES)
  add_subdirectory(examples)
endif()

if(TESSERON_INSTALL)
  include(GNUInstallDirs)
  include(CMakePackageConfigHelpers)

  install(
    TARGETS tesseron
    EXPORT tesseron-targets
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
  install(DIRECTORY include/tesseron DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
  install(
    EXPORT tesseron-targets
    NAMESPACE tesseron::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/tesseron)

  configure_package_config_file(
    cmake/tesseron-config.cmake.in "${CMAKE_CURRENT_BINARY_DIR}/tesseron-config.cmake"
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/tesseron)
  write_basic_package_version_file(
    "${CMAKE_CURRENT_BINARY_DIR}/tesseron-config-version.cmake"
    COMPATIBILITY SameMajorVersion)
  install(FILES "${CMAKE_CURRENT_BINARY_DIR}/tesseron-config.cmake"
                "${CMAKE_CURRENT_BINARY_DIR}/tesseron-config-version.cmake"
          DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/tesseron)
endif()
