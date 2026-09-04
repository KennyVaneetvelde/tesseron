# Every dependency arrives through FetchContent at a pinned version and hash.
# No vcpkg, no Conan, no system package: a Tesseron host has to build from a
# clean checkout with nothing but a compiler, CMake, and a network connection.

include(FetchContent)

set(TESSERON_BOOST_VERSION "1.89.0")
set(TESSERON_BOOST_SHA256 "67acec02d0d118b5de9eb441f5fb707b3a1cdd884be00ca24b9a73c995511f74")
set(TESSERON_NLOHMANN_JSON_VERSION "3.12.0")
set(TESSERON_NLOHMANN_JSON_SHA256
    "42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa")

# CMake 4 refuses a subproject whose cmake_minimum_required predates 3.5, and
# both upstream archives still declare an older floor. This is the escape hatch
# CMake documents for exactly that; drop it when the pins move past it.
if(CMAKE_VERSION VERSION_GREATER_EQUAL "4.0" AND NOT DEFINED CMAKE_POLICY_VERSION_MINIMUM)
  set(CMAKE_POLICY_VERSION_MINIMUM 3.10)
endif()

set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
set(JSON_Install OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  nlohmann_json
  URL "https://github.com/nlohmann/json/releases/download/v${TESSERON_NLOHMANN_JSON_VERSION}/json.tar.xz"
  URL_HASH "SHA256=${TESSERON_NLOHMANN_JSON_SHA256}"
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)

# BOOST_INCLUDE_LIBRARIES is what keeps this from configuring all of Boost:
# only these two and their transitive dependencies become subdirectories.
# Asio is public because handlers return boost::asio::awaitable; Beast is an
# implementation detail of the WebSocket listener and stays private.
set(BOOST_INCLUDE_LIBRARIES asio beast CACHE STRING "" FORCE)
set(BOOST_ENABLE_CMAKE ON CACHE BOOL "" FORCE)
set(BOOST_SKIP_INSTALL_RULES ON CACHE BOOL "" FORCE)
FetchContent_Declare(
  Boost
  URL "https://github.com/boostorg/boost/releases/download/boost-${TESSERON_BOOST_VERSION}/boost-${TESSERON_BOOST_VERSION}-cmake.tar.xz"
  URL_HASH "SHA256=${TESSERON_BOOST_SHA256}"
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)

FetchContent_MakeAvailable(nlohmann_json Boost)
