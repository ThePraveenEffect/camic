// Camic DirectShow filters — DLL entry + COM self-registration.
#include "common.h"
#include "CamicCamera.h"
#include "CamicMic.h"
#include <streams.h>
#include <initguid.h>

HINSTANCE g_hInst = NULL;
static LONG g_serverLocks = 0;

// Factory templates for both filters.
CFactoryTemplate g_Templates[] = {
    {
        L"Camic Camera",
        &CLSID_CamicCamera,
        CamicCamera::CreateInstance,
        NULL,
        NULL
    },
    {
        L"Camic Microphone",
        &CLSID_CamicMic,
        CamicMic::CreateInstance,
        NULL,
        NULL
    },
};
int g_cTemplates = sizeof(g_Templates) / sizeof(g_Templates[0]);

// Standard base-class exports.
STDAPI DllRegisterServer()   { return AMovieDllRegisterServer2(TRUE); }
STDAPI DllUnregisterServer() { return AMovieDllRegisterServer2(FALSE); }

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void **ppv) {
    return AMovieDllGetClassObject(rclsid, riid, (void **)ppv);
}

STDAPI DllCanUnloadNow() {
    return (g_serverLocks == 0 && AMovieGetUnused() == 0) ? S_OK : S_FALSE;
}

extern "C" BOOL WINAPI DllMain(HINSTANCE hInst, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_hInst = hInst;
        DisableThreadLibraryCalls(hInst);
    }
    return TRUE;
}
