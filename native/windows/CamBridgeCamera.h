// Camic Camera — DirectShow video source filter.
// A push-source filter: a worker thread reads YUY2 frames from the named pipe
// (written by the Camic app) and delivers them downstream via CSourceStream.
#ifndef CAMIC_CAMERA_H
#define CAMIC_CAMERA_H

#include "common.h"

// One output pin that pushes YUY2 frames read from the named pipe.
class CamicPin : public CSourceStream {
public:
    CamicPin(HRESULT *phr, CSource *pParent, LPCWSTR pName);
    ~CamicPin();

    // CUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void **ppv);
    STDMETHODIMP_(ULONG) AddRef();
    STDMETHODIMP_(ULONG) Release();

    // CBasePin / CBaseOutputPin
    HRESULT GetMediaType(int iPosition, CMediaType *pMediaType) override;
    HRESULT CheckMediaType(const CMediaType *pMediaType) override;
    HRESULT SetMediaType(const CMediaType *pMediaType) override;
    HRESULT DecideBufferSize(IMemAllocator *pAlloc, ALLOCATOR_PROPERTIES *pprop) override;

    // CSourceStream — called on the worker thread to fill one sample
    HRESULT FillBuffer(IMediaSample *pSample) override;

    HRESULT OnThreadCreate() override;
    HRESULT OnThreadDestroy() override;

private:
    HRESULT ConnectPipe();     // open the named pipe (retry until app writes)
    bool ReadFrame(BYTE *pBuf, long len, VideoFrameHeader *pHdr);

    HANDLE m_hPipe;
    bool   m_bConnected;
    int    m_width;
    int    m_height;
    LONGLONG m_rtFrame;       // running sample time
    REFERENCE_TIME m_rtFrameDelta;
};

// The source filter (owns the pin via CSource's m_paStreams).
class CamicCamera : public CSource {
public:
    static CUnknown * WINAPI CreateInstance(LPUNKNOWN lpunk, HRESULT *phr);

    CamicCamera(LPUNKNOWN lpunk, HRESULT *phr);
    ~CamicCamera();
};

#endif // CAMIC_CAMERA_H
