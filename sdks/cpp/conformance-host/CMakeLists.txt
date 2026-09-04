# The adapter the `@tesseron/conformance` runner drives. Deliberately neither
# installed nor exported: it exists to be launched from the repository, and
# shipping it would put a test harness in a consumer's package.
add_executable(tesseron-conformance-host main.cpp fixture.cpp schema_subset.cpp)

target_link_libraries(tesseron-conformance-host PRIVATE tesseron::tesseron)
target_compile_features(tesseron-conformance-host PRIVATE cxx_std_20)

# The runner is handed one fixed path, so the binary lands somewhere the
# generator cannot move it: no per-configuration subdirectory, no lib prefix.
set_target_properties(
  tesseron-conformance-host
  PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/conformance-host"
             RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/conformance-host"
             RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/conformance-host"
             RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/conformance-host"
             RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/conformance-host")
