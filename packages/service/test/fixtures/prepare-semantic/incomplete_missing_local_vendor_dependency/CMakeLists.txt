project(vendor_parent C)
add_subdirectory(vendor/acme-parser)
add_executable(parent src/main.c)
