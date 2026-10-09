// Uma amostra por segundo; taxas usam o relógio do relatório, não o timer da UI.
export function videoSample(report, direction, previous) {
  const rows = [...report.values()]
  const r = rows.find(r => r.type === `${direction}-rtp` && (r.kind ?? r.mediaType) === 'video' && !r.isRemote)
  if (!r) return null
  const before = previous?.id === r.id && previous?.ssrc === r.ssrc ? previous : null
  const seconds = before ? (r.timestamp - before.timestamp) / 1000 : 0
  const delta = name => seconds > 0 && r[name] != null && before[name] != null && r[name] >= before[name]
    ? r[name] - before[name] : null
  const outbound = direction === 'outbound'
  const frames = delta(outbound ? 'framesEncoded' : 'framesDecoded')
  const bytes = delta(outbound ? 'bytesSent' : 'bytesReceived')
  const lost = delta('packetsLost')
  const received = delta('packetsReceived')
  const emitted = delta('jitterBufferEmittedCount')
  const encodeTime = delta('totalEncodeTime')
  const decodeTime = delta('totalDecodeTime')
  const pairID = rows.find(s => s.type === 'transport' && s.id === r.transportId)?.selectedCandidatePairId
  const pair = report.get(pairID) ?? rows.find(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
  const candidate = report.get(pair?.localCandidateId)
  const codec = report.get(r.codecId)
  return {
    raw: r,
    metrics: {
      timestamp: r.timestamp,
      seconds: seconds > 0 ? seconds : null,
      width: r.frameWidth ?? null,
      height: r.frameHeight ?? null,
      fps: frames != null ? frames / seconds : r.framesPerSecond ?? null,
      mbps: bytes != null ? bytes * 8 / seconds / 1_000_000 : null,
      lossPercent: lost != null && received != null && lost + received > 0 ? lost * 100 / (lost + received) : null,
      droppedFrames: delta('framesDropped'),
      freezes: delta('freezeCount'),
      freezeSeconds: delta('totalFreezesDuration'),
      retransmittedPackets: delta('retransmittedPacketsSent'),
      encodeMs: frames > 0 && encodeTime != null ? encodeTime * 1000 / frames : null,
      decodeMs: frames > 0 && decodeTime != null ? decodeTime * 1000 / frames : null,
      jitterBufferMs: emitted > 0 && delta('jitterBufferDelay') != null ? delta('jitterBufferDelay') * 1000 / emitted : null,
      rttMs: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      limitation: r.qualityLimitationReason ?? null,
      codec: codec?.mimeType ?? null,
      codecParameters: codec?.sdpFmtpLine ?? null,
      transport: candidate?.protocol ?? null,
      candidateType: candidate?.candidateType ?? null,
    },
  }
}
