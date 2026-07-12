project(versioned C)
add_custom_command(OUTPUT generated/version.c COMMAND ${CMAKE_COMMAND} -DINPUT=${CMAKE_SOURCE_DIR}/schema/version.txt -DOUTPUT=generated/version.c -P tools/generate.cmake DEPENDS schema/version.txt tools/generate.cmake)
add_executable(versioned src/main.c generated/version.c)
