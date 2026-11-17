import React from 'react';
import { Crosshair, Globe, Navigation, Users, X } from 'lucide-react';
import {
  haversineMeters,
  type LiveLocationRecord,
} from '../../core/firebase/LiveLocationCloudService';
import type { LiveGpsFix } from '../../core/navigation/LiveGpsService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface PeerLocationInspectorProps {
  peer: LiveLocationRecord;
  userLocation: LiveGpsFix | null;
  theme?: MapTheme;
  onCenterPeer: (peer: LiveLocationRecord) => void;
  onNavigateToPeer: (peer: LiveLocationRecord) => void;
  onClose: () => void;
}

function formatAgeLabel(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'לא ידוע';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 15) return 'עכשיו';
  if (diffSec < 60) return `לפני ${diffSec} שנ׳`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `לפני ${mins} דק׳`;
  const hrs = Math.floor(mins / 60);
  return `לפני ${hrs} ש׳`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} מ׳`;
  return `${(meters / 1000).toFixed(1)} ק״מ`;
}

export const PeerLocationInspector: React.FC<PeerLocationInspectorProps> = ({
  peer,
  userLocation,
  theme = 'topo-dark',
  onCenterPeer,
  onNavigateToPeer,
  onClose,
}) => {
  const t = getSurfaceTheme(theme);
  const distMeters = userLocation
    ? haversineMeters(userLocation.lon, userLocation.lat, peer.lon, peer.lat)
    : null;
  const speedKmh =
    typeof peer.speed === 'number' && Number.isFinite(peer.speed) && peer.speed > 0.5
      ? Math.round(peer.speed * 3.6)
      : null;

  return (
    <div
      dir="rtl"
      className={`fixed bottom-16 md:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[min(92vw,360px)] rounded-2xl border shadow-2xl p-3.5 space-y-3 ${t.panel}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          {peer.photoURL ? (
            <img
              src={peer.photoURL}
              alt={peer.displayName}
              className="w-9 h-9 rounded-full object-cover border-2 shrink-0"
              style={{ borderColor: peer.accentColor || '#0ea5e9' }}
            />
          ) : (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0 border-2 border-white/80"
              style={{ backgroundColor: peer.accentColor || '#0ea5e9' }}
            >
              {peer.displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold truncate">{peer.displayName}</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-md inline-flex items-center gap-1 shrink-0 ${
                  peer.visibility === 'public'
                    ? 'bg-sky-500/15 text-sky-400'
                    : 'bg-emerald-500/15 text-emerald-400'
                }`}
              >
                {peer.visibility === 'public' ? (
                  <>
                    <Globe className="w-2.5 h-2.5" /> ציבורי
                  </>
                ) : (
                  <>
                    <Users className="w-2.5 h-2.5" /> משותף איתך
                  </>
                )}
              </span>
            </div>
            <div className={`text-[11px] flex flex-wrap items-center gap-2 ${t.muted}`}>
              <span>עודכן {formatAgeLabel(peer.updatedAt)}</span>
              {distMeters !== null && <span>• מרחק {formatDistance(distMeters)}</span>}
              {speedKmh !== null && <span>• {speedKmh} קמ״ש</span>}
              {peer.altitude !== null && <span>• גובה {Math.round(peer.altitude)}מ׳</span>}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-slate-500/15 transition-colors shrink-0"
          aria-label="סגור"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onCenterPeer(peer)}
          className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${t.subCard}`}
        >
          <Crosshair className="w-3.5 h-3.5 text-sky-400" />
          <span>מרכז מפה</span>
        </button>
        <button
          type="button"
          onClick={() => onNavigateToPeer(peer)}
          className="py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
        >
          <Navigation className="w-3.5 h-3.5" />
          <span>נווט אליו</span>
        </button>
      </div>
    </div>
  );
};
