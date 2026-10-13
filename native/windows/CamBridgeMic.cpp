// Camic Mic — implementation.
#include "CamicMic.h"

#pragma comment(lib, "strmiids.lib")

// ---------------- CamicAudioPin ----------------

CamicAudioPin::CamicAudioPin(HRESULT *phr, CSource *pParent, LPCWSTR pName)
    : CSourceStream(NAME("CamicAudioPin"), phr, pParent, pName),
      m_hPipe(INVALID_HANDLE_VALUE), m_bConnected(false), m_rtSample(0),
      m_rtFrameDelta((REFERENCE_TIME)AUD_SAMPLES_PER_BUF * 10000000 / AUD_SAMPLE_RATE)
{
}

CamicAudioPin::~CamicAudioPin() {
    if (m_hPipe != INVALID_HANDLE_VALUE) { CloseHandle(m_hPipe); m_hPipe = INVALID_HANDLE_VALUE; }
}

HRESULT CamicAudioPin::GetMediaType(int iPosition, CMediaType *pMediaType) {
    if (iPosition < 0) return E_INVALIDARG;
    WAVEFORMATEX *wfx = (WAVEFORMATEX *)pMediaType->AllocBuffer(sizeof(WAVEFORMATEX));
    if (!wfx) return E_OUTOFMEMORY;
    ZeroMemory(wfx, sizeof(*wfx));
    wfx->wFormatTag      = WAVE_FORMAT_PCM;
    wfx->nChannels       = AUD_CHANNELS;
    wfx->nSamplesPerSec  = AUD_SAMPLE_RATE;
    wfx->wBitsPerSample  = AUD_BITS;
    wfx->nBlockAlign     = AUD_BLOCK_ALIGN;
    wfx->nAvgBytesPerSec = AUD_BYTES_PER_SEC;
    wfx->cbSize          = 0;

    pMediaType->SetType(&MEDIATYPE_Audio);
    pMediaType->SetSubtype(&MEDIASUBTYPE_PCM);
    pMediaType->SetFormatType(&FORMAT_WaveFormatEx);
    pMediaType->SetSampleSize(AUD_BUF_BYTES);
    pMediaType->SetFixedSize(FALSE);
    pMediaType->SetTemporalCompression(FALSE);
    return S_OK;
}

HRESULT CamicAudioPin::CheckMediaType(const CMediaType *pMediaType) {
    if (*pMediaType->Type() != MEDIATYPE_Audio) return E_FAIL;
    if (*pMediaType->Subtype() != MEDIASUBTYPE_PCM) return E_FAIL;
    if (*pMediaType->FormatType() != FORMAT_WaveFormatEx) return E_FAIL;
    return S_OK;
}

HRESULT CamicAudioPin::DecideBufferSize(IMemAllocator *pAlloc, ALLOCATOR_PROPERTIES *pprop) {
    pprop->cBuffers = 4;
    pprop->cbBuffer = AUD_BUF_BYTES;
    ALLOCATOR_PROPERTIES actual;
    HRESULT hr = pAlloc->SetProperties(pprop, &actual);
    if (FAILED(hr)) return hr;
    if (actual.cbBuffer < AUD_BUF_BYTES) return E_FAIL;
    return S_OK;
}

HRESULT CamicAudioPin::OnThreadCreate() { m_rtSample = 0; m_bConnected = false; return S_OK; }

HRESULT CamicAudioPin::OnThreadDestroy() {
    if (m_hPipe != INVALID_HANDLE_VALUE) { CloseHandle(m_hPipe); m_hPipe = INVALID_HANDLE_VALUE; }
    m_bConnected = false;
    return S_OK;
}

HRESULT CamicAudioPin::ConnectPipe() {
    if (m_bConnected) return S_OK;
    m_hPipe = CreateFileW(AUDIO_PIPE_NAME, GENERIC_READ, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (m_hPipe == INVALID_HANDLE_VALUE) {
        if (GetLastError() == ERROR_PIPE_BUSY) {
            WaitNamedPipeW(AUDIO_PIPE_NAME, 2000);
            m_hPipe = CreateFileW(AUDIO_PIPE_NAME, GENERIC_READ, 0, NULL, OPEN_EXISTING, 0, NULL);
        }
    }
    if (m_hPipe == INVALID_HANDLE_VALUE) return E_FAIL;
    m_bConnected = true;
    return S_OK;
}

HRESULT CamicAudioPin::FillBuffer(IMediaSample *pSample) {
    BYTE *pData = NULL;
    HRESULT hr = pSample->GetPointer(&pData);
    if (FAILED(hr)) return hr;

    DWORD read = 0;
    if (SUCCEEDED(ConnectPipe())) {
        // read up to one buffer of PCM; on EOF/pipe close, fall through to silence
        if (!ReadFile(m_hPipe, pData, AUD_BUF_BYTES, &read, NULL) || read == 0) {
            m_bConnected = false; CloseHandle(m_hPipe); m_hPipe = INVALID_HANDLE_VALUE; read = 0;
        }
    }
    if (read < AUD_BUF_BYTES) {
        ZeroMemory(pData + read, AUD_BUF_BYTES - read);
        read = AUD_BUF_BYTES;
    }
    pSample->SetActualDataLength(read);

    REFERENCE_TIME t1 = m_rtSample, t2 = t1 + m_rtFrameDelta;
    pSample->SetTime(&t1, &t2);
    pSample->SetSyncPoint(TRUE);
    m_rtSample += m_rtFrameDelta;
    return S_OK;
}

// ---------------- CamicMic ----------------

CUnknown * WINAPI CamicMic::CreateInstance(LPUNKNOWN lpunk, HRESULT *phr) {
    CamicMic *p = new CamicMic(lpunk, phr);
    if (!p) { if (phr) *phr = E_OUTOFMEMORY; }
    return p;
}

CamicMic::CamicMic(LPUNKNOWN lpunk, HRESULT *phr)
    : CSource(NAME("Camic Microphone"), lpunk, CLSID_CamicMic, phr)
{
    m_paStreams = (CSourceStream **) new CamicAudioPin*[1];
    if (!m_paStreams) { if (phr) *phr = E_OUTOFMEMORY; return; }
    m_paStreams[0] = new CamicAudioPin(phr, this, L"Camic Microphone");
    m_cStreams = 1;
}

CamicMic::~CamicMic() {}
