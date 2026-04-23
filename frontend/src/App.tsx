import React, { useEffect, useRef, useState } from 'react'
import type { Dayjs } from 'dayjs'
import {
  Alert, Badge, Button, Card, Col, ConfigProvider, Form, Input, InputNumber,
  Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, TimePicker,
  Typography, theme as antTheme, type TableColumnsType,
} from 'antd'
import {
  WifiOutlined, ClockCircleOutlined,
  PlusOutlined, DeleteOutlined, ClearOutlined,
  BulbOutlined, BulbFilled, SyncOutlined, PoweroffOutlined,
  UserOutlined, LockOutlined, LogoutOutlined,
} from '@ant-design/icons'
import type { Schedule, Status, ControlCmd } from './types'
import { login, sendControl } from './api'

const { Text } = Typography

const WEB_APP_VERSION = '1.1.0'

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

interface LoginPageProps {
  onLogin: (token: string) => void
}

function LoginPage({ onLogin }: LoginPageProps) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [form] = Form.useForm<{ username: string; password: string }>()

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true)
    setError(null)
    try {
      const token = await login(values.username, values.password)
      localStorage.setItem('auth_token', token)
      onLogin(token)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ConfigProvider theme={{ algorithm: antTheme.darkAlgorithm }}>
      <div style={{
        minHeight: '100vh', background: '#141414',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}>
        <div style={{
          background: '#1f1f1f', border: '1px solid #303030', borderRadius: 12,
          padding: '32px 28px', width: '100%', maxWidth: 360,
        }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 40 }}>💧</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1890ff', marginTop: 8 }}>
              Tank Monitor
            </div>
            <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
              Sign in to continue
            </div>
          </div>

          {error && (
            <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />
          )}

          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter username' }]}>
              <Input prefix={<UserOutlined />} placeholder="admin" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter password' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="Password" autoComplete="current-password" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" loading={loading} block>
                Sign In
              </Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </ConfigProvider>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(s: number): string {
  if (s < 60)   return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** Convert 24-hr "HH:MM" or "HH:MM:SS" to "H:MM AM/PM" */
function to12hr(t: string): string {
  try {
    const parts = t.split(':')
    let h = parseInt(parts[0], 10)
    const m = parts[1].padStart(2, '0')
    const ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    return `${h}:${m} ${ampm}`
  } catch {
    return t
  }
}

/** Return the schedule index (i) of the next upcoming schedule for a motor */
function getNextSchedIdx(schedules: Schedule[], motor: string, currentTime: string): number | null {
  const filtered = schedules.filter(s => s.m === motor)
  if (!filtered.length || !currentTime) return null
  const [ch, cm] = currentTime.split(':').map(Number)
  const nowMins = ch * 60 + (cm || 0)
  let nextIdx: number | null = null
  let minDiff = Infinity
  for (const sch of filtered) {
    const [sh, sm] = sch.t.split(':').map(Number)
    let diff = sh * 60 + sm - nowMins
    if (diff <= 0) diff += 24 * 60
    if (diff < minDiff) { minDiff = diff; nextIdx = sch.i }
  }
  return nextIdx
}

// ---------------------------------------------------------------------------
// SVG arc tank level circle (mirrors ESP32 webserver UI)
// ---------------------------------------------------------------------------

function TankCircle({ state, darkMode }: { state: string; darkMode: boolean }) {
  const r    = 45
  const circ = 2 * Math.PI * r  // ≈ 283

  let pct   = 0
  let color = '#8c8c8c'

  if      (state === 'FULL')  { pct = 1.0; color = '#52c41a' }
  else if (state === 'LOW')   { pct = 0.3; color = '#fa8c16' }
  else if (state === 'EMPTY') { pct = 0.0; color = '#ff4d4f' }

  const dash   = pct * circ
  const arcBg  = darkMode ? '#303030' : '#e8e8e8'

  return (
    <div style={{ position: 'relative', display: 'inline-block', width: 110, height: 110, marginBottom: 8 }}>
      <svg width="110" height="110" viewBox="0 0 110 110" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="55" cy="55" r={r} fill="none" stroke={arcBg} strokeWidth={9} />
        <circle
          cx="55" cy="55" r={r} fill="none"
          stroke={color} strokeWidth={9} strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: 'stroke-dasharray 0.5s, stroke 0.5s' }}
        />
      </svg>
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        fontSize: 13, fontWeight: 700, color,
        textAlign: 'center', lineHeight: 1.2,
      }}>
        {state || '--'}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Motor status pill (mirrors ESP32 webserver UI)
// ---------------------------------------------------------------------------

function MotorPill({ on, darkMode }: { on: boolean; darkMode: boolean }) {
  const onBg  = darkMode ? '#162312' : '#f6ffed'
  const onClr = '#52c41a'
  const onBd  = darkMode ? '#274916' : '#b7eb8f'
  const offBg = darkMode ? '#2a1215' : '#fff1f0'
  const offClr = '#ff4d4f'
  const offBd  = darkMode ? '#58181c' : '#ffa39e'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
      background: on ? onBg  : offBg,
      color:      on ? onClr : offClr,
      border:     `1px solid ${on ? onBd : offBd}`,
    }}>
      ● {on ? 'ON' : 'OFF'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Per-tank card: circle + motor pill + ON/OFF buttons
// ---------------------------------------------------------------------------

interface TankCardProps {
  title:     string
  tankState: string
  motorOn:   boolean
  onOn:      () => void
  onOff:     () => void
  darkMode:  boolean
}

function TankCard({ title, tankState, motorOn, onOn, onOff, darkMode }: TankCardProps) {
  const cardBg  = darkMode ? '#1f1f1f' : '#ffffff'
  const cardBd  = darkMode ? '#303030' : '#d9d9d9'
  const rowBg   = darkMode ? '#262626' : '#f5f5f5'
  const labelCl = darkMode ? '#8c8c8c' : '#8c8c8c'
  return (
    <div style={{
      background: cardBg, border: `1px solid ${cardBd}`, borderRadius: 12,
      padding: 16, textAlign: 'center',
    }}>
      <div style={{ fontSize: 11, color: labelCl, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
        {title}
      </div>
      <TankCircle state={tankState} darkMode={darkMode} />
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: rowBg, borderRadius: 8, padding: '6px 12px', marginBottom: 10,
      }}>
        <span style={{ fontSize: 11, color: labelCl }}>Motor</span>
        <MotorPill on={motorOn} darkMode={darkMode} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Button
          type="primary" size="small"
          style={{ flex: 1, background: '#1890ff', borderColor: '#1890ff' }}
          onClick={onOn}
        >ON</Button>
        <Button danger size="small" style={{ flex: 1 }} onClick={onOff}>OFF</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form type for Add Schedule modal
// ---------------------------------------------------------------------------

interface AddForm {
  motor:    0 | 1
  time:     Dayjs
  duration: number
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function App() {
  const [token,      setToken]      = useState<string | null>(() => localStorage.getItem('auth_token'))
  const [status,     setStatus]     = useState<Status | null>(null)
  const [connected,  setConnected]  = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [addOpen,    setAddOpen]    = useState(false)
  const [ctrlError,  setCtrlError]  = useState<string | null>(null)
  const [darkMode,   setDarkMode]   = useState(true)
  const [form] = Form.useForm<AddForm>()
  const wsRef = useRef<WebSocket | null>(null)

  const handleLogout = () => {
    localStorage.removeItem('auth_token')
    setToken(null)
    wsRef.current?.close()
    setConnected(false)
    setStatus(null)
  }

  // ── WebSocket connection ──────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const connect = () => {
      const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`)
      ws.onopen    = () => setConnected(true)
      ws.onclose   = () => { setConnected(false); setTimeout(connect, 3000) }
      ws.onerror   = () => ws.close()
      ws.onmessage = ({ data }) => {
        try {
          setStatus(JSON.parse(data as string))
          setLastUpdate(new Date())
        } catch { /* ignore malformed */ }
      }
      wsRef.current = ws
    }
    connect()
    return () => { wsRef.current?.close() }
  }, [token])

  // ── Show login page if not authenticated ──────────────────────────────────
  if (!token) {
    return <LoginPage onLogin={setToken} />
  }

  // ── Control helper ────────────────────────────────────────────────────────
  const ctrl = (cmd: ControlCmd) =>
    sendControl(cmd, token).catch((e: Error) => {
      if (e.message === 'SESSION_EXPIRED') { handleLogout(); return }
      setCtrlError(e.message)
      setTimeout(() => setCtrlError(null), 4000)
    })

  // ── Schedule table columns ────────────────────────────────────────────────
  const schedCols: TableColumnsType<Schedule> = [
    { title: '#',        dataIndex: 'i', width: 40 },
    {
      title: 'Motor', dataIndex: 'm', width: 70,
      render: (m: string) => <Tag color={m === 'OH' ? 'blue' : 'purple'}>{m}</Tag>,
    },
    { title: 'Time', dataIndex: 't', width: 90, render: (t: string) => to12hr(t) },
    { title: 'Duration', dataIndex: 'd', render: (d: number) => `${d} min` },
    {
      title: '', key: 'del', width: 48,
      render: (_: unknown, r: Schedule) => (
        <Popconfirm
          title="Remove this schedule?"
          onConfirm={() => ctrl({ cmd: 'sched_remove', index: r.i })}
          okText="Yes" cancelText="No"
        >
          <Button type="text" danger size="small" icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  // ── Add schedule form submit ──────────────────────────────────────────────
  const onAdd = async (v: AddForm) => {
    await ctrl({ cmd: 'sched_add', motor: v.motor, time: v.time.format('HH:mm'), duration: v.duration })
    setAddOpen(false)
    form.resetFields()
  }

  const s = status

  // All schedules shown; next upcoming per motor for row highlight
  const activeSchedules = s?.schedules ?? []
  const nextOH = s?.time ? getNextSchedIdx(activeSchedules, 'OH', s.time) : null
  const nextUG = s?.time ? getNextSchedIdx(activeSchedules, 'UG', s.time) : null

  // ── System info rows ──────────────────────────────────────────────────────
  const sysRows: [string, React.ReactNode][] = [
    ['WiFi',        s?.wifi_rssi != null ? `${s.wifi_rssi} dBm` : '—'],
    ['LoRa',        <Tag color={s?.lora_ok ? 'success' : (s ? 'error' : 'default')}>{s?.lora_ok ? 'OK' : (s ? 'FAIL' : '—')}</Tag>],
    ['Uptime',      s ? formatUptime(s.uptime_s) : '—'],
    ['Firmware',    s?.fw ?? '—'],
    ['Web App',     WEB_APP_VERSION],
    ['Last update', lastUpdate ? lastUpdate.toLocaleTimeString() : '—'],
  ]

  const bg       = darkMode ? '#141414' : '#f0f2f5'
  const cardBg   = darkMode ? '#1f1f1f' : '#ffffff'
  const cardBd   = darkMode ? '#303030' : '#d9d9d9'
  const rowBd    = darkMode ? '#303030' : '#f0f0f0'
  const labelClr = darkMode ? '#8c8c8c' : '#8c8c8c'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ConfigProvider theme={{ algorithm: darkMode ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm }}>
      <div style={{ minHeight: '100vh', background: bg, padding: '16px 20px' }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 20, paddingBottom: 12,
          borderBottom: `1px solid ${cardBd}`,
        }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#1890ff' }}>
            💧 Tank Monitor
          </span>
          <Space size={12}>
            {s?.time && (
              <Text style={{ color: labelClr, fontSize: 12 }}>
                <ClockCircleOutlined /> {to12hr(s.time)}
              </Text>
            )}
            <Badge
              status={connected ? 'success' : 'error'}
              text={<span style={{ color: labelClr, fontSize: 12 }}>{connected ? 'Live' : 'Offline'}</span>}
            />
            <Button
              size="small"
              type="text"
              icon={darkMode ? <BulbFilled style={{ color: '#faad14' }} /> : <BulbOutlined />}
              onClick={() => setDarkMode(d => !d)}
              title={darkMode ? 'Switch to Light' : 'Switch to Dark'}
            >
              {darkMode ? 'Light' : 'Dark'}
            </Button>
            <Button
              size="small"
              type="text"
              danger
              icon={<LogoutOutlined />}
              onClick={handleLogout}
              title="Sign out"
            >
              Logout
            </Button>
          </Space>
        </div>

        {/* ── Banners ── */}
        {!connected && (
          <Alert message="Disconnected — reconnecting…" type="warning" showIcon style={{ marginBottom: 12 }} />
        )}
        {ctrlError && (
          <Alert message={ctrlError} type="error" showIcon closable style={{ marginBottom: 12 }} />
        )}

        {/* ── Tank Cards (2-column, mirrors ESP32 layout) ── */}
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12}>
            <TankCard
              title="Underground Tank"
              tankState={s?.ug_state ?? ''}
              motorOn={s?.ug_motor ?? false}
              onOn={()  => ctrl({ cmd: 'ug_on'  })}
              onOff={() => ctrl({ cmd: 'ug_off' })}
              darkMode={darkMode}
            />
          </Col>
          <Col xs={12}>
            <TankCard
              title="Overhead Tank"
              tankState={s?.oh_state ?? ''}
              motorOn={s?.oh_motor ?? false}
              onOn={()  => ctrl({ cmd: 'oh_on'  })}
              onOff={() => ctrl({ cmd: 'oh_off' })}
              darkMode={darkMode}
            />
          </Col>
        </Row>

        {/* ── Schedules ── */}
        <Card
          size="small"
          title={<span style={{ fontSize: 11, color: labelClr, textTransform: 'uppercase', letterSpacing: 1 }}>Motor Scheduler</span>}
          style={{ background: cardBg, border: `1px solid ${cardBd}`, borderRadius: 12, marginBottom: 12 }}
          extra={
            <Space>
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
                Add
              </Button>
              <Popconfirm
                title="Clear all schedules?"
                onConfirm={() => ctrl({ cmd: 'sched_clear' })}
                okText="Yes" cancelText="No"
              >
                <Button size="small" danger icon={<ClearOutlined />}>Clear All</Button>
              </Popconfirm>
            </Space>
          }
        >
          <Table<Schedule>
            dataSource={activeSchedules}
            columns={schedCols}
            rowKey="i"
            size="small"
            pagination={false}
            locale={{ emptyText: 'No schedules configured' }}
            onRow={(record) => ({
              style: record.i === nextOH || record.i === nextUG
                ? { background: '#162312', borderLeft: '3px solid #52c41a' }
                : {},
            })}
          />
        </Card>

        {/* ── Settings ── */}
        <Card
          size="small"
          title={<span style={{ fontSize: 11, color: labelClr, textTransform: 'uppercase', letterSpacing: 1 }}>Settings</span>}
          style={{ background: cardBg, border: `1px solid ${cardBd}`, borderRadius: 12, marginBottom: 12 }}
        >
          {([
            ['OH Display Only',          'oh_disp_only',  s?.oh_disp_only],
            ['UG Display Only',          'ug_disp_only',  s?.ug_disp_only],
            ['Ignore UG for OH Motor',   'ug_ignore',     s?.ug_ignore],
            ['Buzzer Delay Before Start','buzzer_delay',  s?.buzzer_delay],
          ] as [string, string, boolean | undefined][]).map(([label, key, val]) => (
            <div key={key} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '7px 0', borderBottom: `1px solid ${rowBd}`, fontSize: 13,
            }}>
              <span>{label}</span>
              <Switch
                size="small"
                checked={val ?? false}
                disabled={!s}
                onChange={(checked) => ctrl({ cmd: 'set_setting', key, value: checked })}
              />
            </div>
          ))}
        </Card>

        {/* ── Actions ── */}
        <Card
          size="small"
          title={<span style={{ fontSize: 11, color: labelClr, textTransform: 'uppercase', letterSpacing: 1 }}>Actions</span>}
          style={{ background: cardBg, border: `1px solid ${cardBd}`, borderRadius: 12, marginBottom: 12 }}
        >
          <Space wrap>
            <Button
              icon={<SyncOutlined />}
              disabled={!s}
              onClick={() => ctrl({ cmd: 'sync_ntp' })}
            >
              Sync NTP Time
            </Button>
            <Popconfirm
              title="Reboot the ESP32?"
              onConfirm={() => ctrl({ cmd: 'reboot' })}
              okText="Reboot" cancelText="Cancel"
              okButtonProps={{ danger: true }}
            >
              <Button icon={<PoweroffOutlined />} danger disabled={!s}>
                Reboot
              </Button>
            </Popconfirm>
          </Space>
        </Card>

        {/* ── System Info (bottom) ── */}
        <Card
          size="small"
          title={<span style={{ fontSize: 11, color: labelClr, textTransform: 'uppercase', letterSpacing: 1 }}>System</span>}
          style={{ background: cardBg, border: `1px solid ${cardBd}`, borderRadius: 12 }}
        >
          {sysRows.map(([label, value]) => (
            <div key={label} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 0', borderBottom: `1px solid ${rowBd}`, fontSize: 13,
            }}>
              <span style={{ color: labelClr }}>
                {label === 'WiFi' && <WifiOutlined style={{ marginRight: 4 }} />}
                {label}
              </span>
              <span style={{ fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </Card>

        {/* ── Add Schedule Modal ── */}
        <Modal
          title="Add Schedule"
          open={addOpen}
          onOk={() => form.submit()}
          onCancel={() => { setAddOpen(false); form.resetFields() }}
          okText="Add"
          destroyOnClose
        >
          <Form
            form={form}
            layout="vertical"
            onFinish={onAdd}
            initialValues={{ motor: 0, duration: 30 }}
          >
            <Form.Item name="motor" label="Motor" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 0, label: 'OH — Overhead' },
                  { value: 1, label: 'UG — Underground' },
                ]}
              />
            </Form.Item>
            <Form.Item name="time" label="Start Time" rules={[{ required: true, message: 'Please select a time' }]}>
              <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="duration" label="Duration (minutes)" rules={[{ required: true }]}>
              <InputNumber min={1} max={480} style={{ width: '100%' }} addonAfter="min" />
            </Form.Item>
          </Form>
        </Modal>

      </div>
    </ConfigProvider>
  )
}
