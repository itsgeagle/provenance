import { Routes, Route, Navigate } from 'react-router-dom';

function LoadPlaceholder() {
  return <div data-testid="load-placeholder">Load view — drop a bundle here</div>;
}

function OverviewPlaceholder() {
  return <div data-testid="overview-placeholder">Overview view — submission summary</div>;
}

function TimelinePlaceholder() {
  return <div data-testid="timeline-placeholder">Timeline view — raw event log</div>;
}

export function App() {
  return (
    <Routes>
      <Route path="/load" element={<LoadPlaceholder />} />
      <Route path="/overview" element={<OverviewPlaceholder />} />
      <Route path="/timeline" element={<TimelinePlaceholder />} />
      <Route path="/" element={<Navigate to="/load" replace />} />
    </Routes>
  );
}
