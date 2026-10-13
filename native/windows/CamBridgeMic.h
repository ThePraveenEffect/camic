// Camic Mic — DirectShow audio source filter.
// Pushes s16le PCM read from the named pipe as a microphone source that apps
// (Zoom/Teams/OBS) can select as an input device.
#ifndef CAMIC_MIC_H
#define CAMIC_MIC_H

#include "common.h"
#include <mmreg.h>

#define AUD_SAMPLE_RATE 48000
#define AUD_CHANNELS    1
#define AUD_BITS        16
#define AUD_BYTES_PER_SEC (AUD_SAMPLE_RATE * AUD_CHANNELS * (AUD_BITS / 8))
#define AUD_BLOCK_ALIGN  (AUD_CHANNELS * (AUD_BITS / 8))
// ~20ms buffers
#define AUD_SAMPLES_PER_BUF (AUD_SAMPLE_RATE / 50)
#define AUD_BUF_BYTES (AUD_SAMPLES_PER_BUF * AUD_BLOCK_ALIGN)

class CamicAudioPin : public CSourceStream {
public:
    CamicAudioPin(HRESULT *phr, CSource *pParent, LPCWSTR pName);
    ~CamicAudioPin();

    HRESULT GetMediaType(int iPosition, CMediaType *pMediaType) override;
    HRESULT CheckMediaType(const CMediaType *pMediaType) override;
    HRESULT DecideBufferSize(IMemAllocator *pAlloc, ALLOCATOR_PROPERTIES *pprop) override;
    HRESULT FillBuffer(IMediaSample *pSample) override;
    HRESULT OnThreadCreate() override;
    HRESULT OnThreadDestroy() override;

private:
    HRESULT ConnectPipe();
    HANDLE m_hPipe;
    bool   m_bConnected;
    LONGLONG m_rtSample;
    REFERENCE_TIME m_rtFrameDelta;
};

class CamicMic : public CSource {
public:
    static CUnknown * WINAPI CreateInstance(LPUNKNOWN lpunk, HRESULT *phr);
    CamicMic(LPUNKNOWN lpunk, HRESULT *phr);
    ~CamicMic();
};

#endif // CAMIC_MIC_H
