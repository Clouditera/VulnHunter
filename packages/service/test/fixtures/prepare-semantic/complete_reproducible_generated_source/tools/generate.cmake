file(READ "${INPUT}" VERSION_VALUE)
file(WRITE "${OUTPUT}" "int generated_version(void){return ${VERSION_VALUE};}\n")
