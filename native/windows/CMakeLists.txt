cmake_minimum_required(VERSION 3.16)
project(CamicFilters CXX)

# Camic DirectShow filters (video + mic).
# Build on WINDOWS with MSVC + the Windows SDK (which provides the DirectShow
# base classes). See BUILD_WINDOWS_DLL.md for step-by-step instructions.
#
#   cmake -B build -G "Visual Studio 17 2022" -A x64
#   cmake --build build --config Release
#
# Output: build/Release/CamicFilters.dll  (register with register.bat)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT WIN32)
    message(FATAL_ERROR "CamicFilters must be built on Windows with MSVC (DirectShow base classes).")
endif()

add_library(CamicFilters SHARED
    CamicCamera.cpp
    CamicMic.cpp
    dllmain.cpp
    CamicFilters.def
)

target_include_directories(CamicFilters PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# Link the DirectShow / COM libraries.
target_link_libraries(CamicFilters PRIVATE
    strmiids      # DirectShow GUIDs
    quartz        # quartz.dll (filter registration helpers)
    winmm         # multimedia
    ole32
    oleaut32
    uuid
)

# The base classes (streams.h / AMovie...) live in the Windows SDK samples
# "baseclasses" project. Point BASECLASSES_DIR at a built baseclasses dir, or
# rely on the SDK's installed copy. Adjust to your machine:
#   set(BASECLASSES_DIR "C:/Program Files (x86)/Windows Kits/10/Include/<ver>/um/..." )
# Most setups build the "baseclasses" sample from the Windows SDK samples and
# link its static lib. Add its include/lib here:
if(DEFINED BASECLASSES_DIR)
    target_include_directories(CamicFilters PRIVATE ${BASECLASSES_DIR}/Include)
    target_link_libraries(CamicFilters PRIVATE ${BASECLASSES_DIR}/Lib/BaseClasses/baseclasses.lib)
endif()

target_compile_definitions(CamicFilters PRIVATE _WIN32_WINNT=0x0A00 UNICODE _UNICODE)

set_target_properties(CamicFilters PROPERTIES OUTPUT_NAME "CamicFilters")
