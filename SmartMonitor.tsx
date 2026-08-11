import { useEffect, useRef, useState } from "react";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { motion } from "framer-motion";

// =====================================================
// ESP32 CONFIGURATION
// =====================================================
// The ESP32 sketch only exposes plain HTTP routes on port 80:
//   GET /api/ultrasonic
//   GET /calibrate/empty
//   GET /calibrate/full
// There is NO WebSocket server (no :81/ws), no voltage/current
// sensing, and no relay. Everything below is derived only from
// polling /api/ultrasonic.

const ESP32_IP = "10.41.212.119";

const ULTRASONIC_API = `http://${ESP32_IP}/api/ultrasonic`;

// =====================================================
// WATER TANK CONFIGURATION
// =====================================================
// Defaults only used until the first successful poll returns
// the ESP32's real capacity/emptyDistance/fullDistance.
// This is a real 1000-liter household tank, so all volume
// units are LITERS (not mL) — matches the ESP32 firmware.

const WATER_CAPACITY_LITERS = 1000;

// Placeholder calibration distances — the ESP32 overwrites
// these once it has real /calibrate/empty and /calibrate/full
// readings for your actual tank height.
const EMPTY_DISTANCE_CM = 150.0;
const FULL_DISTANCE_CM = 5.0;

// =====================================================
// TYPES
// =====================================================

interface WaterPoint {
  time: string;
  level: number;
  volume: number; // liters
}

// Mirrors the exact JSON shape produced by handleUltrasonic() in the
// ESP32 sketch. Numeric fields are null when there is no valid echo
// (distanceCm < 0), so every numeric field must be treated as
// number | null, not just optional.
interface ESP32TelemetryData {
  distance?: number | null;
  waterLevelPercent?: number | null;
  waterLevelCm?: number | null;
  waterVolume?: number | null; // liters

  capacity?: number; // liters
  emptyDistance?: number;
  fullDistance?: number;

  status?: string; // "NO_ECHO" | "FULL" | "NORMAL" | "LOW" | "VERY_LOW" | "EMPTY"

  buzzer?: boolean;
  greenLED?: boolean;
  redLED?: boolean;
}

// =====================================================
// MAIN COMPONENT
// =====================================================

export default function SmartMonitor() {
  // ===================================================
  // CONNECTION
  // ===================================================

  const [isConnected, setIsConnected] = useState(false);

  // ===================================================
  // HARDWARE (only what the ESP32 actually reports)
  // ===================================================

  const [buzzer, setBuzzer] = useState(false);
  const [greenLed, setGreenLed] = useState(false);
  const [redLed, setRedLed] = useState(false);

  // ===================================================
  // BUZZER POPUP
  // ===================================================

  const [showBuzzerPopup, setShowBuzzerPopup] = useState(false);
  const previousBuzzer = useRef(false);

  // ===================================================
  // WATER
  // ===================================================

  const [waterLevel, setWaterLevel] = useState(0);
  const [waterLevelCm, setWaterLevelCm] = useState(0);
  const [waterDistance, setWaterDistance] = useState(0);
  const [waterStatus, setWaterStatus] = useState("NO DATA");

  const [emptyDistance, setEmptyDistance] = useState(EMPTY_DISTANCE_CM);
  const [fullDistance, setFullDistance] = useState(FULL_DISTANCE_CM);

  const [capacityL, setCapacityL] = useState(WATER_CAPACITY_LITERS);
  const [currentVolumeL, setCurrentVolumeL] = useState(0);

  const [waterGraph, setWaterGraph] = useState<WaterPoint[]>([]);

  // ===================================================
  // WATER LEVEL POLLING (the ESP32's only data source)
  // ===================================================

  useEffect(() => {
    let mounted = true;

    const fetchWaterLevel = async () => {
      try {
        const response = await fetch(`${ULTRASONIC_API}?t=${Date.now()}`, {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data: ESP32TelemetryData = await response.json();

        if (!mounted) return;

        // ESP32 REACHABLE
        setIsConnected(true);

        // BUZZER / LEDS
        if (typeof data.buzzer === "boolean") setBuzzer(data.buzzer);
        if (typeof data.greenLED === "boolean") setGreenLed(data.greenLED);
        if (typeof data.redLED === "boolean") setRedLed(data.redLED);

        // DISTANCE (null on NO_ECHO)
        const distance =
          typeof data.distance === "number" && Number.isFinite(data.distance)
            ? data.distance
            : NaN;

        setWaterDistance(Number.isFinite(distance) ? distance : 0);

        // CALIBRATION (the ESP32 always sends these, even on NO_ECHO)
        const empty =
          typeof data.emptyDistance === "number"
            ? data.emptyDistance
            : EMPTY_DISTANCE_CM;

        const full =
          typeof data.fullDistance === "number"
            ? data.fullDistance
            : FULL_DISTANCE_CM;

        setEmptyDistance(empty);
        setFullDistance(full);

        const capacity =
          typeof data.capacity === "number" && data.capacity > 0
            ? data.capacity
            : WATER_CAPACITY_LITERS;

        setCapacityL(capacity);

        // WATER LEVEL % (ESP32 sends this directly; null on NO_ECHO)
        let level = 0;

        if (
          typeof data.waterLevelPercent === "number" &&
          Number.isFinite(data.waterLevelPercent)
        ) {
          level = data.waterLevelPercent;
        } else if (Number.isFinite(distance) && empty > full) {
          level = ((empty - distance) / (empty - full)) * 100;
        }

        level = Math.max(0, Math.min(100, level));

        // WATER HEIGHT (cm)
        let height = 0;

        if (
          typeof data.waterLevelCm === "number" &&
          Number.isFinite(data.waterLevelCm)
        ) {
          height = Math.max(0, data.waterLevelCm);
        } else if (empty > full) {
          height = (level / 100) * (empty - full);
        }

        // VOLUME (liters) — ESP32 sends waterVolume directly; null on NO_ECHO
        let volume = 0;

        if (
          typeof data.waterVolume === "number" &&
          Number.isFinite(data.waterVolume)
        ) {
          volume = data.waterVolume;
        } else {
          volume = (level / 100) * capacity;
        }

        volume = Math.max(0, Math.min(capacity, volume));

        setWaterLevel(level);
        setWaterLevelCm(height);
        setCurrentVolumeL(Math.round(volume * 10) / 10); // 1 decimal, e.g. 734.5 L

        // STATUS: pass the ESP32's own status straight through.
        // getWaterStatus() on the device returns one of:
        // NO_ECHO | FULL | NORMAL | LOW | VERY_LOW | EMPTY
        const status =
          typeof data.status === "string" ? data.status : "NO_ECHO";

        setWaterStatus(status);

        // GRAPH
        const now = new Date();
        const time = now.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        setWaterGraph((oldGraph) => {
          const newPoint: WaterPoint = {
            time,
            level: Number(level.toFixed(1)),
            volume: Math.round(volume * 10) / 10,
          };

          const updated = [...oldGraph, newPoint];

          if (updated.length > 30) {
            updated.shift();
          }

          return updated;
        });
      } catch (error) {
        console.error("ESP32 water API error:", error);

        if (mounted) {
          setIsConnected(false);
          setWaterStatus("SENSOR OFFLINE");
        }
      }
    };

    fetchWaterLevel();

    const interval = setInterval(fetchWaterLevel, 1000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // ===================================================
  // BUZZER POPUP
  // ===================================================

  useEffect(() => {
    if (buzzer === true && previousBuzzer.current === false) {
      setShowBuzzerPopup(true);

      const timer = setTimeout(() => {
        setShowBuzzerPopup(false);
      }, 5000);

      previousBuzzer.current = buzzer;

      return () => {
        clearTimeout(timer);
      };
    }

    previousBuzzer.current = buzzer;
  }, [buzzer]);

  const closeBuzzerPopup = () => {
    setShowBuzzerPopup(false);
  };

  // ===================================================
  // DERIVED WATER STATE
  // ===================================================

  const isWaterEmpty = waterStatus === "EMPTY" || waterLevel <= 0;
  const isWaterLow =
    waterStatus === "LOW" || waterStatus === "VERY_LOW";
  const isWaterFull = waterStatus === "FULL" || waterLevel >= 95;
  const isNoEcho = waterStatus === "NO_ECHO";

  const getWaterStatusText = () => {
    if (!isConnected) return "Sensor Offline";

    switch (waterStatus) {
      case "NO_ECHO":
        return "No Echo";
      case "FULL":
        return "Full Tank";
      case "NORMAL":
        return "Normal";
      case "LOW":
        return "Low Water";
      case "VERY_LOW":
        return "Very Low";
      case "EMPTY":
        return "Empty";
      default:
        return "Unknown";
    }
  };

  // ===================================================
  // RENDER
  // ===================================================

  return (
    <div style={styles.pageRoot} className="monitor-layout">
      {/* ========================================= */}
      {/* BUZZER POPUP */}
      {/* ========================================= */}

      {showBuzzerPopup && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8, y: -30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8 }}
          style={styles.buzzerPopup}
        >
          <div style={styles.buzzerIcon}>🔊</div>

          <div style={{ flex: 1 }}>
            <div style={styles.buzzerPopupTitle}>WATER LEVEL ALERT</div>

            <div style={styles.buzzerPopupMessage}>
              Water level has reached a critical level (95%+).
            </div>

            <div style={styles.buzzerPopupLevel}>
              Current Level: {waterLevel.toFixed(1)}%
            </div>
          </div>

          <button onClick={closeBuzzerPopup} style={styles.buzzerCloseButton}>
            ×
          </button>
        </motion.div>
      )}

      {/* ========================================= */}
      {/* HEADER */}
      {/* ========================================= */}

      <header style={styles.header}>
        <div style={styles.userProfile}>
          <div style={styles.avatar}>💧</div>

          <div>
            <h1 style={styles.headerTitle}>Smart Water Tank Monitor</h1>

            <div style={styles.statusBadge}>
              <span
                style={{
                  ...styles.liveDot,
                  backgroundColor: isConnected ? "#22c55e" : "#ef4444",
                  boxShadow: isConnected
                    ? "0 0 8px #22c55e"
                    : "0 0 8px #ef4444",
                }}
              />

              <span
                style={{
                  fontSize: 12,
                  color: isConnected ? "#4ade80" : "#fca5a5",
                  fontWeight: 700,
                }}
              >
                {isConnected ? "ESP32 CONNECTED" : "ESP32 DISCONNECTED"}
              </span>
            </div>
          </div>
        </div>

        <button style={styles.iconButton}>🔔</button>
      </header>

      {/* ========================================= */}
      {/* CONNECTION STATUS */}
      {/* ========================================= */}

      <div
        style={{
          ...styles.connectionCard,
          borderColor: isConnected ? "#166534" : "#7f1d1d",
          backgroundColor: isConnected
            ? "rgba(34,197,94,0.08)"
            : "rgba(239,68,68,0.08)",
        }}
      >
        <span>
          {isConnected
            ? "🟢 ESP32 Hardware Connected"
            : "🔴 ESP32 Hardware Disconnected"}
        </span>

        <span style={{ fontSize: 11, color: "#94a3b8" }}>
          {isConnected ? "Polling /api/ultrasonic every 1s" : "Waiting for ESP32..."}
        </span>
      </div>

      {/* ========================================= */}
      {/* WATER LEVEL SUMMARY BANNER */}
      {/* ========================================= */}

      <div style={styles.bannerCard}>
        <div>
          <span style={styles.bannerLabel}>Current Water Level</span>

          <div style={styles.bannerValue}>
            {waterLevel.toFixed(1)}
            <span style={{ fontSize: 18 }}> %</span>
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <span style={styles.bannerLabel}>Tank Status</span>

          <div
            style={{
              color: isWaterFull || isWaterLow ? "#ef4444" : "#22c55e",
              fontWeight: "bold",
              fontSize: 16,
            }}
          >
            {isWaterFull
              ? "⚠️ Full"
              : isWaterLow
              ? "⚠️ Low"
              : isNoEcho
              ? "● No Echo"
              : "● Nominal"}
          </div>
        </div>
      </div>

      {/* ========================================= */}
      {/* CRITICAL LEVEL ALERT */}
      {/* ========================================= */}

      {isWaterFull && isConnected && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          style={styles.alertBanner}
        >
          <span>🚨</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            Water Level Critical — Buzzer Triggered (≥95%)
          </span>
        </motion.div>
      )}

      {/* ========================================= */}
      {/* MAIN GRID */}
      {/* ========================================= */}

      <div className="grid-primary">
        {/* ======================================= */}
        {/* WATER RESERVOIR */}
        {/* ======================================= */}

        <div className="full-width-span">
          <h2 style={styles.sectionHeader}>Water Tank (1000 L)</h2>

          <div style={styles.waterCard} className="waterCard">
            <div style={styles.tankWrapper} className="tankWrapper">
              <div style={styles.tickScale}>
                <span>100%</span>
                <span>75%</span>
                <span>50%</span>
                <span>25%</span>
                <span>0%</span>
              </div>

              <div style={styles.glassTank}>
                <motion.div
                  animate={{ height: `${waterLevel}%` }}
                  transition={{ type: "spring", stiffness: 45, damping: 12 }}
                  style={{
                    ...styles.liquidFill,
                    background:
                      isWaterLow || isWaterEmpty
                        ? "linear-gradient(180deg,#f87171,#ef4444)"
                        : "linear-gradient(180deg,#38bdf8,#1d4ed8)",
                  }}
                >
                  <div style={styles.waveSurface} />
                </motion.div>

                <div style={styles.glassHighlight} />
              </div>
            </div>

            <div style={styles.waterMetrics}>
              <span style={styles.metricLabel}>CURRENT WATER LEVEL</span>

              <div style={styles.metricBigValue}>
                {waterLevel.toFixed(1)}
                <span style={{ fontSize: 20, color: "#38bdf8" }}>%</span>
              </div>

              <div style={styles.metricRow}>
                <span style={styles.metricSubLabel}>Current Volume</span>
                <span style={styles.metricSubValue}>
                  {currentVolumeL.toFixed(1)} / {capacityL} L
                </span>
              </div>

              <div style={styles.metricRow}>
                <span style={styles.metricSubLabel}>Water Height</span>
                <span style={styles.metricSubValue}>
                  {waterLevelCm.toFixed(1)} cm
                </span>
              </div>

              <div style={styles.metricRow}>
                <span style={styles.metricSubLabel}>Sensor Distance</span>
                <span style={styles.metricSubValue}>
                  {waterDistance.toFixed(1)} cm
                </span>
              </div>

              <div style={styles.metricRow}>
                <span style={styles.metricSubLabel}>Status</span>
                <span
                  style={{
                    ...styles.statusTag,
                    backgroundColor: !isConnected
                      ? "rgba(239,68,68,.2)"
                      : isWaterLow || isWaterEmpty
                      ? "rgba(239,68,68,.2)"
                      : isWaterFull
                      ? "rgba(34,197,94,.2)"
                      : "rgba(56,189,248,.2)",
                    color: !isConnected
                      ? "#fca5a5"
                      : isWaterLow || isWaterEmpty
                      ? "#fca5a5"
                      : isWaterFull
                      ? "#86efac"
                      : "#7dd3fc",
                  }}
                >
                  {getWaterStatusText()}
                </span>
              </div>

              <div style={styles.metricRow}>
                <span style={styles.metricSubLabel}>Buzzer</span>
                <span
                  style={{
                    ...styles.statusTag,
                    backgroundColor: buzzer
                      ? "rgba(239,68,68,.2)"
                      : "rgba(34,197,94,.2)",
                    color: buzzer ? "#fca5a5" : "#86efac",
                  }}
                >
                  {buzzer ? "🔊 ON" : "🔇 OFF"}
                </span>
              </div>

              <div style={styles.metricRow}>
                <span style={styles.metricSubLabel}>Empty / Full</span>
                <span style={styles.metricSubValue}>
                  {emptyDistance.toFixed(1)} / {fullDistance.toFixed(1)} cm
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ======================================= */}
        {/* WATER GRAPH */}
        {/* ======================================= */}

        <div className="full-width-span">
          <h2 style={styles.sectionHeader}>Water Level History</h2>

          <div style={styles.chartCard}>
            <div style={styles.graphHeader}>
              <div>
                <span style={styles.graphTitle}>REALTIME WATER MONITOR</span>
                <div style={styles.graphCurrent}>{waterLevel.toFixed(1)}%</div>
              </div>

              <div style={styles.graphLegend}>
                <span>● Water Level</span>
              </div>
            </div>

            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={waterGraph}
                  margin={{ top: 10, right: 15, left: -15, bottom: 5 }}
                >
                  <defs>
                    <linearGradient id="waterGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#1d4ed8" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>

                  <CartesianGrid stroke="#334155" strokeDasharray="3 3" />

                  <XAxis
                    dataKey="time"
                    tick={{ fill: "#64748b", fontSize: 10 }}
                  />

                  <YAxis
                    domain={[0, 100]}
                    tick={{ fill: "#64748b", fontSize: 10 }}
                    tickFormatter={(value) => `${value}%`}
                  />

                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0f172a",
                      borderColor: "#334155",
                      borderRadius: 8,
                      color: "#fff",
                    }}
                  />

                  <Area
                    type="monotone"
                    dataKey="level"
                    stroke="#38bdf8"
                    strokeWidth={3}
                    fill="url(#waterGradient)"
                    dot={false}
                    activeDot={{ r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div style={styles.graphFooter}>
              <span>
                Current: <strong>{waterLevel.toFixed(1)}%</strong>
              </span>

              <span>
                Volume: <strong>{currentVolumeL.toFixed(1)} L</strong>
              </span>

              <span>
                Capacity: <strong>{capacityL} L</strong>
              </span>
            </div>
          </div>
        </div>

        {/* ======================================= */}
        {/* HARDWARE STATUS */}
        {/* ======================================= */}

        <div className="full-width-span">
          <h2 style={styles.sectionHeader}>Hardware Status</h2>

          <div style={styles.hardwareCard}>
            <div style={styles.hardwareGrid}>
              {/* ESP32 / ULTRASONIC (single check — same HTTP poll) */}

              <div style={styles.hardwareStatusBox}>
                <span style={styles.hardwareLabel}>ESP32 / Ultrasonic</span>
                <span style={styles.hardwareValue}>
                  {isConnected ? "🟢 Online" : "🔴 Offline"}
                </span>
              </div>

              {/* BUZZER */}

              <div
                style={{
                  ...styles.hardwareStatusBox,
                  borderColor: buzzer ? "#ef4444" : "#334155",
                  backgroundColor: buzzer
                    ? "rgba(239,68,68,0.15)"
                    : "#0f172a",
                  boxShadow: buzzer
                    ? "0 0 12px rgba(239,68,68,0.30)"
                    : "none",
                }}
              >
                <span style={styles.hardwareLabel}>Buzzer</span>
                <span
                  style={{
                    ...styles.hardwareValue,
                    color: buzzer ? "#f87171" : "#f8fafc",
                  }}
                >
                  {buzzer ? "🔊 ON" : "🔇 OFF"}
                </span>
              </div>

              {/* GREEN LED — on for normal levels (<95%) */}

              <div
                style={{
                  ...styles.hardwareStatusBox,
                  borderColor: greenLed ? "#22c55e" : "#334155",
                  backgroundColor: greenLed
                    ? "rgba(34,197,94,0.15)"
                    : "#0f172a",
                  boxShadow: greenLed
                    ? "0 0 15px rgba(34,197,94,0.40)"
                    : "none",
                  transition: "all 0.3s ease",
                }}
              >
                <span
                  style={{
                    ...styles.hardwareLabel,
                    color: greenLed ? "#86efac" : "#94a3b8",
                  }}
                >
                  Green LED
                </span>

                <span
                  style={{
                    ...styles.hardwareValue,
                    color: greenLed ? "#22c55e" : "#f8fafc",
                    fontWeight: 800,
                  }}
                >
                  {greenLed ? "🟢 ON" : "⚪ OFF"}
                </span>
              </div>

              {/* RED LED — on when water level >= 95% */}

              <div
                style={{
                  ...styles.hardwareStatusBox,
                  borderColor: redLed ? "#ef4444" : "#334155",
                  backgroundColor: redLed
                    ? "rgba(239,68,68,0.15)"
                    : "#0f172a",
                  boxShadow: redLed
                    ? "0 0 15px rgba(239,68,68,0.30)"
                    : "none",
                  transition: "all 0.3s ease",
                }}
              >
                <span
                  style={{
                    ...styles.hardwareLabel,
                    color: redLed ? "#fca5a5" : "#94a3b8",
                  }}
                >
                  Red LED
                </span>

                <span
                  style={{
                    ...styles.hardwareValue,
                    color: redLed ? "#ef4444" : "#f8fafc",
                    fontWeight: 800,
                  }}
                >
                  {redLed ? "🔴 ON" : "⚪ OFF"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ========================================= */}
      {/* CSS */}
      {/* ========================================= */}

      <style>
        {`
          .monitor-layout {
            width: 100%;
            max-width: 1200px;
            margin: 0 auto;
            padding: 16px;
            box-sizing: border-box;
          }

          .grid-primary {
            display: grid;
            grid-template-columns: 1fr;
            gap: 20px;
          }

          .full-width-span {
            grid-column: 1 / -1;
          }

          @media (min-width: 768px) {
            .monitor-layout {
              padding: 24px;
            }
          }

          @media (max-width: 700px) {
            .waterCard {
              flex-direction: column !important;
              align-items: stretch !important;
            }

            .tankWrapper {
              justify-content: center;
            }
          }
        `}
      </style>
    </div>
  );
}

// =====================================================
// STYLES
// =====================================================

const styles: Record<string, React.CSSProperties> = {
  pageRoot: {
    minHeight: "100vh",
    backgroundColor: "#020617",
    color: "#f8fafc",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },

  // BUZZER POPUP

  buzzerPopup: {
    position: "fixed",
    top: 20,
    right: 20,
    zIndex: 9999,
    width: 360,
    maxWidth: "calc(100vw - 40px)",
    background: "linear-gradient(135deg,#450a0a,#7f1d1d)",
    border: "2px solid #ef4444",
    borderRadius: 16,
    padding: 16,
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 10px 40px rgba(239,68,68,.35)",
  },

  buzzerIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: "rgba(239,68,68,.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 26,
  },

  buzzerPopupTitle: {
    color: "#fca5a5",
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: 0.5,
  },

  buzzerPopupMessage: {
    color: "#fecaca",
    fontSize: 12,
    marginTop: 4,
  },

  buzzerPopupLevel: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 700,
    marginTop: 6,
  },

  buzzerCloseButton: {
    width: 30,
    height: 30,
    border: "none",
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,.1)",
    color: "#fff",
    fontSize: 22,
    cursor: "pointer",
  },

  // HEADER

  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 16,
    marginBottom: 12,
    borderBottom: "1px solid #1e293b",
  },

  userProfile: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },

  avatar: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#1e293b",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontSize: 20,
    border: "1px solid #334155",
  },

  headerTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: "#fff",
  },

  statusBadge: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },

  liveDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
  },

  iconButton: {
    background: "#1e293b",
    border: "1px solid #334155",
    color: "#fff",
    borderRadius: 12,
    width: 40,
    height: 40,
    cursor: "pointer",
  },

  // CONNECTION

  connectionCard: {
    border: "1px solid",
    borderRadius: 12,
    padding: "10px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    fontSize: 13,
    fontWeight: 700,
  },

  // BANNER

  bannerCard: {
    background: "linear-gradient(135deg,#1e293b 0%,#0f172a 100%)",
    border: "1px solid #334155",
    borderRadius: 18,
    padding: "16px 20px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },

  bannerLabel: {
    fontSize: 11,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  bannerValue: {
    fontSize: 26,
    fontWeight: 800,
    color: "#38bdf8",
  },

  alertBanner: {
    backgroundColor: "rgba(239,68,68,.15)",
    border: "1px solid #ef4444",
    borderRadius: 14,
    padding: "12px 16px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
    color: "#fca5a5",
  },

  // SECTION

  sectionHeader: {
    fontSize: 13,
    fontWeight: 700,
    color: "#94a3b8",
    margin: "0 0 12px 2px",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },

  // WATER

  waterCard: {
    backgroundColor: "#1e293b",
    borderRadius: 20,
    padding: 18,
    border: "1px solid #334155",
    display: "flex",
    gap: 18,
    alignItems: "center",
    minHeight: 250,
    boxSizing: "border-box",
  },

  tankWrapper: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },

  tickScale: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    height: 170,
    fontSize: 9,
    color: "#64748b",
  },

  glassTank: {
    width: 65,
    height: 170,
    backgroundColor: "rgba(15,23,42,.8)",
    border: "2px solid #475569",
    borderRadius: 14,
    position: "relative",
    overflow: "hidden",
    display: "flex",
    alignItems: "flex-end",
  },

  liquidFill: {
    width: "100%",
    position: "relative",
  },

  waveSurface: {
    position: "absolute",
    top: -4,
    left: 0,
    width: "140%",
    height: 8,
    backgroundColor: "rgba(255,255,255,.4)",
    borderRadius: "50%",
  },

  glassHighlight: {
    position: "absolute",
    top: 0,
    left: 4,
    width: 6,
    height: "100%",
    background:
      "linear-gradient(180deg,rgba(255,255,255,.25),rgba(255,255,255,.02))",
    pointerEvents: "none",
  },

  waterMetrics: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },

  metricLabel: {
    fontSize: 10,
    color: "#94a3b8",
    textTransform: "uppercase",
  },

  metricBigValue: {
    fontSize: 32,
    fontWeight: 800,
    color: "#fff",
  },

  metricRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderTop: "1px solid #334155",
    paddingTop: 8,
  },

  metricSubLabel: {
    fontSize: 12,
    color: "#94a3b8",
  },

  metricSubValue: {
    fontSize: 12,
    fontWeight: 700,
    color: "#f8fafc",
  },

  statusTag: {
    padding: "3px 8px",
    borderRadius: 6,
    fontSize: 10,
    fontWeight: 700,
  },

  // GRAPH

  chartCard: {
    backgroundColor: "#1e293b",
    borderRadius: 20,
    padding: 20,
    border: "1px solid #334155",
  },

  graphHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },

  graphTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#94a3b8",
    letterSpacing: 0.5,
  },

  graphCurrent: {
    fontSize: 24,
    fontWeight: 800,
    color: "#38bdf8",
    marginTop: 5,
  },

  graphLegend: {
    display: "flex",
    gap: 14,
    fontSize: 12,
    fontWeight: 600,
    color: "#38bdf8",
  },

  graphFooter: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 14,
    paddingTop: 12,
    borderTop: "1px solid #334155",
    fontSize: 12,
    color: "#94a3b8",
  },

  // HARDWARE

  hardwareCard: {
    backgroundColor: "#1e293b",
    borderRadius: 20,
    padding: 20,
    border: "1px solid #334155",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },

  hardwareGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))",
    gap: 12,
  },

  hardwareStatusBox: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: "12px 16px",
    border: "1px solid #334155",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    transition: "all 0.3s ease",
  },

  hardwareLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#94a3b8",
    textTransform: "uppercase",
  },

  hardwareValue: {
    fontSize: 14,
    fontWeight: 700,
    color: "#f8fafc",
  },
};