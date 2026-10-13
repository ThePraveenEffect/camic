// Camic Camera — implementation.
#include "CamicCamera.h"
#include <mmreg.h>
#include <aviriff.h>

#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "winmm.lib")

// ---------------- CamicPin ----------------

CamicPin::CamicPin(HRESULT *phr, CSource *pParent, LPCWSTR pName)
    : CSourceStream(NAME("CamicPin"), phr, pParent, pName),
      m_hPipe(INVALID_HANDLE_VALUE), m_bConnected(false),
      m_width(1280), m_height(720), m_rtFrame(0),
      m_rtFrameDelta(333333) // ~30fps default (100ns units)
{
}

CamicPin::~CamicPin() {
    if (m_hPipe != INVALID_HANDLE_VALUE) { CloseHandle(m_hPipe); m_hPipe = INVALID_HANDLE_VALUE; }
}

STDMETHODIMP CamicPin::QueryInterface(REFIID riid, void **ppv) {
    return CSourceStream::QueryInterface(riid, ppv);
}
STDMETHODIMP_(ULONG) CamicPin::AddRef() { return CSourceStream::AddRef(); }
STDMETHODIMP_(ULONG) CamicPin::Release() { return CSourceStream::Release(); }

HRESULT CamicPin::GetMediaType(int iPosition, CMediaType *pMediaType) {
    if (iPosition < 0) return E_INVALIDARG;
    VIDEOINFOHEADER *pVih = (VIDEOINFOHEADER *)pMediaType->AllocBuffer(sizeof(VIDEOINFOHEADER));
    if (!pVih) return E_OUTOFMEMORY;
    VIDEOINFOHEADER& vih = *pVih;
    ZeroMemory(&vih, sizeof(vih));
    vih.rcSource.right  = m_width;
    vih.rcSource.bottom = m_height;
    vih.rcTarget        = vih.rcSource;
    vih.AvgTimePerFrame = m_rtFrameDelta;
    vih.dwBitRate       = m_width * m_height * 16 * 30; // YUY2 ~16bpp
    vih.bmiHeader.biSize        = sizeof(BITMAPINFOHEADER);
    vih.bmiHeader.biWidth       = m_width;
    vih.bmiHeader.biHeight      = m_height;
    vih.bmiHeader.biPlanes      = 1;
    vih.bmiHeader.biBitCount    = 16;
    vih.bmiHeader.biCompression = MAKEFOURCC('Y','U','Y','2');
    vih.bmiHeader.biSizeImage   = m_width * m_height * 2;

    pMediaType->SetType(&MEDIATYPE_Video);
    pMediaType->SetSubtype(&MEDIASUBTYPE_YUY2);
    pMediaType->SetFormatType(&FORMAT_VideoInfo);
    pMediaType->SetSampleSize(m_width * m_height * 2);
    pMediaType->SetFixedSize(TRUE);
    pMediaType->SetTemporalCompression(FALSE);
    return S_OK;
}

HRESULT CamicPin::CheckMediaType(const CMediaType *pMediaType) {
    if (*pMediaType->Type() != MEDIATYPE_Video) return E_FAIL;
    if (*pMediaType->Subtype() != MEDIASUBTYPE_YUY2) return E_FAIL;
    if (*pMediaType->FormatType() != FORMAT_VideoInfo) return E_FAIL;
    return S_OK;
}

HRESULT CamicPin::SetMediaType(const CMediaType *pMediaType) {
    VIDEOINFOHEADER *pVih = (VIDEOINFOHEADER *)pMediaType->Format();
    if (pVih) {
        m_width  = pVih->bmiHeader.biWidth;
        m_height = abs(pVih->bmiHeader.biHeight);
        if (pVih->AvgTimePerFrame > 0) m_rtFrameDelta = pVih->AvgTimePerFrame;
    }
    return CSourceStream::SetMediaType(pMediaType);
}

HRESULT CamicPin::DecideBufferSize(IMemAllocator *pAlloc, ALLOCATOR_PROPERTIES *pprop) {
    long size = m_width * m_height * 2;
    pprop->cBuffers = 1;
    pprop->cbBuffer = size;
    ALLOCATOR_PROPERTIES actual;
    HRESULT hr = pAlloc->SetProperties(pprop, &actual);
    if (FAILED(hr)) return hr;
    if (actual.cbBuffer < size) return E_FAIL;
    return S_OK;
}

HRESULT CamicPin::OnThreadCreate() {
    m_rtFrame = 0;
    m_bConnected = false;
    return S_OK;
}

HRESULT CamicPin::OnThreadDestroy() {
    if (m_hPipe != INVALID_HANDLE_VALUE) { CloseHandle(m_hPipe); m_hPipe = INVALID_HANDLE_VALUE; }
    m_bConnected = false;
    return S_OK;
}

HRESULT CamicPin::ConnectPipe() {
    if (m_bConnected) return S_OK;
    // The Camic app is the pipe server; we connect as client and retry.
    m_hPipe = CreateFileW(VIDEO_PIPE_NAME, GENERIC_READ, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (m_hPipe == INVALID_HANDLE_VALUE) {
        if (GetLastError() == ERROR_PIPE_BUSY) {
            WaitNamedPipeW(VIDEO_PIPE_NAME, 2000);
            m_hPipe = CreateFileW(VIDEO_PIPE_NAME, GENERIC_READ, 0, NULL, OPEN_EXISTING, 0, NULL);
        }
    }
    if (m_hPipe == INVALID_HANDLE_VALUE) return E_FAIL;
    m_bConnected = true;
    return S_OK;
}

bool CamicPin::ReadFrame(BYTE *pBuf, long len, VideoFrameHeader *pHdr) {
    DWORD read = 0;
    if (!ReadFile(m_hPipe, pHdr, sizeof(VideoFrameHeader), &read, NULL) || read != sizeof(VideoFrameHeader)) {
        m_bConnected = false; CloseHandle(m_hPipe); m_hPipe = INVALID_HANDLE_VALUE; return false;
    }
    // use header dims if they differ (mid-stream resize)
    if (pHdr->width && pHdr->height) { m_width = pHdr->width; m_height = pHdr->height; }
    long need = m_width * m_height * 2;
    if (need > len) need = len;
    DWORD got = 0;
    while (got < (DWORD)need) {
        if (!ReadFile(m_hPipe, pBuf + got, need - got, &read, NULL) || read == 0) {
            m_bConnected = false; CloseHandle(m_hPipe); m_hPipe = INVALID_HANDLE_VALUE; return false;
        }
        got += read;
    }
    return true;
}

HRESULT CamicPin::FillBuffer(IMediaSample *pSample) {
    BYTE *pData = NULL;
    HRESULT hr = pSample->GetPointer(&pData);
    if (FAILED(hr)) return hr;
    long size = pSample->GetSize();

    // Connect/reconnect the pipe; if no app is streaming, emit black frames so
    // the graph keeps running (mirrors a webcam with no signal gracefully).
    if (FAILED(ConnectPipe())) {
        Sleep(33);
        ZeroMemory(pData, m_width * m_height * 2);
        pSample->SetActualDataLength(m_width * m_height * 2);
        REFERENCE_TIME t1 = m_rtFrame, t2 = t1 + m_rtFrameDelta;
        pSample->SetTime(&t1, &t2);
        pSample->SetSyncPoint(TRUE);
        m_rtFrame += m_rtFrameDelta;
        return S_OK;
    }

    VideoFrameHeader hdr;
    if (!ReadFrame(pData, size, &hdr)) {
        // pipe closed — fall back to black this frame, will retry next call
        ZeroMemory(pData, m_width * m_height * 2);
    }
    long dataLen = m_width * m_height * 2;
    pSample->SetActualDataLength(dataLen);

    REFERENCE_TIME t1 = m_rtFrame, t2 = t1 + m_rtFrameDelta;
    pSample->SetTime(&t1, &t2);
    pSample->SetSyncPoint(TRUE);
    m_rtFrame += m_rtFrameDelta;
    return S_OK;
}

// ---------------- CamicCamera ----------------

CUnknown * WINAPI CamicCamera::CreateInstance(LPUNKNOWN lpunk, HRESULT *phr) {
    CamicCamera *p = new CamicCamera(lpunk, phr);
    if (!p) { if (phr) *phr = E_OUTOFMEMORY; }
    return p;
}

CamicCamera::CamicCamera(LPUNKNOWN lpunk, HRESULT *phr)
    : CSource(NAME("Camic Camera"), lpunk, CLSID_CamicCamera, phr)
{
    // Standard push-source registration (Windows SDK sample pattern):
    // allocate the pin array and add one pin. CSource owns/deletes the pins.
    m_paStreams = (CSourceStream **) new CamicPin*[1];
    if (!m_paStreams) { if (phr) *phr = E_OUTOFMEMORY; return; }
    m_paStreams[0] = new CamicPin(phr, this, L"Camic Camera");
    m_cStreams = 1;
}

CamicCamera::~CamicCamera() {
    // CSource deletes its pins in its dtor; m_pPin owned by base.
}
