project(model_runner C)
add_executable(model_runner src/main.c)
configure_file(assets/model.bin assets/model.bin COPYONLY)
