/**
 * TimelineView — /local route wrapper around TimelineInner.
 *
 * Supplies the EventIndex from BundleContext and the /local replay target.
 * All behavior lives in TimelineInner, which the server-backed Timeline tab
 * mounts against an API-derived index.
 *
 * PRD §7.2 ("Raw timeline").
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { TimelineInner } from './TimelineInner.js';

export function TimelineView() {
  const { index } = useBundle();
  const navigate = useNavigate();

  const handleJumpToReplay = useCallback(
    (event: IndexedEvent) => {
      void navigate(`/local/replay/${event.sessionId}?event=${event.globalIdx}`);
    },
    [navigate],
  );

  return <TimelineInner index={index} onJumpToReplay={handleJumpToReplay} />;
}
