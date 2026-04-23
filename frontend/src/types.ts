export interface Schedule {
  i: number    // slot index in ESP32 schedules[]
  m: 'OH' | 'UG'
  t: string    // "HH:MM"
  d: number    // duration in minutes
  on: boolean  // currently running
}

export interface Status {
  oh_state:      string
  ug_state:      string
  oh_motor:      boolean
  ug_motor:      boolean
  lora_ok:       boolean
  wifi_rssi:     number
  uptime_s:      number
  fw:            string
  time:          string
  schedules:     Schedule[]
  // Settings
  oh_disp_only:  boolean
  ug_disp_only:  boolean
  ug_ignore:     boolean
  buzzer_delay:  boolean
  lcd_bl_mode:   number   // 0=auto, 1=always_on, 2=always_off
}

export interface ControlCmd {
  cmd:       string
  motor?:    number
  time?:     string
  duration?: number
  index?:    number
  key?:      string
  value?:    boolean
  mode?:     string
  url?:      string
}

export interface OtaStatus {
  has_firmware: boolean
  filename:     string
  size:         number
  uploaded_at:  string
  phase:        string   // idle | triggered | downloading | success | failed
  prev_fw:      string
}
