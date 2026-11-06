// thrust stand firmware - adafruit esp32-s3 feather
// esc: hobbywing skywalker 60a v2, signal on pin 5
// load cell: 5 kg s-type -> adafruit nau7802 over stemma qt (i2c)
//
// serial commands (115200, newline):
//   t<us>    set throttle pulse, e.g. t1200  (1000-2000)
//   s        stop (1000 us)
//   z        tare
//   c<grams> calibrate with known mass/force applied, e.g. c500
//   p        print calibration
//
// watchdog: above min throttle, any gap in commands > 500 ms stops the motor.
// the ui resends throttle every 100 ms while armed.
//
// output csv: ms,throttle_us,raw,thrust_g
// status lines start with '#'

#include <Wire.h>
#include <Adafruit_NAU7802.h>
#include <Preferences.h>

const int ESC_PIN  = 5;
const int PWM_FREQ = 50;     // standard servo rate
const int PWM_RES  = 14;     // max ledc resolution on s3 at 50 hz
const int US_MIN   = 1000;
const int US_MAX   = 2000;
const unsigned long CMD_TIMEOUT_MS = 500;

Adafruit_NAU7802 nau;
Preferences prefs;

int     throttle_us  = US_MIN;
int32_t tare_raw     = 0;
float   counts_per_g = 1.0f;  // loaded from flash, set with 'c'
unsigned long last_cmd_ms = 0;
String  line;

void setThrottle(int us) {
  throttle_us = constrain(us, US_MIN, US_MAX);
  uint32_t duty = (uint32_t)throttle_us * ((1UL << PWM_RES) - 1) / 20000UL;
  ledcWrite(ESC_PIN, duty);
}

int32_t avgRaw(int n) {
  int64_t sum = 0;
  for (int i = 0; i < n; i++) {
    while (!nau.available()) delay(1);
    sum += nau.read();
  }
  return (int32_t)(sum / n);
}

void printCal() {
  Serial.printf("# cpg %.6f\n", counts_per_g);
}

void handle(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;
  char c = cmd.charAt(0);
  float v = cmd.substring(1).toFloat();
  last_cmd_ms = millis();

  if (c == 't') {
    setThrottle((int)v);
  } else if (c == 's') {
    setThrottle(US_MIN);
  } else if (c == 'z') {
    tare_raw = avgRaw(40);
    Serial.println("# tared");
  } else if (c == 'c' && v > 0) {
    // apply the known force in the same direction thrust will act
    int32_t r = avgRaw(40);
    counts_per_g = (float)(r - tare_raw) / v;
    prefs.putFloat("cpg", counts_per_g);
    Serial.println("# calibrated");
    printCal();
  } else if (c == 'p') {
    printCal();
  } else {
    setThrottle(US_MIN);  // unknown input -> fail safe
    Serial.println("# stop: unknown command");
  }
}

void setup() {
  // hold esc at min throttle before anything else
  ledcAttach(ESC_PIN, PWM_FREQ, PWM_RES);
  setThrottle(US_MIN);

  Serial.begin(115200);

#if defined(PIN_I2C_POWER)
  // stemma qt port power on the feather
  pinMode(PIN_I2C_POWER, OUTPUT);
  digitalWrite(PIN_I2C_POWER, HIGH);
  delay(10);
#endif

  Wire.begin();
  while (!nau.begin()) {
    Serial.println("# nau7802 not found, retrying");
    delay(1000);
  }
  nau.setLDO(NAU7802_3V0);
  nau.setGain(NAU7802_GAIN_128);
  nau.setRate(NAU7802_RATE_80SPS);

  // settle, then on-chip calibration
  for (int i = 0; i < 10; i++) { while (!nau.available()) delay(1); nau.read(); }
  nau.calibrate(NAU7802_CALMOD_INTERNAL);
  nau.calibrate(NAU7802_CALMOD_OFFSET);

  prefs.begin("stand", false);
  counts_per_g = prefs.getFloat("cpg", 1.0f);

  tare_raw = avgRaw(40);
  Serial.println("# ready");
  printCal();
  Serial.println("ms,throttle_us,raw,thrust_g");
}

void loop() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') { handle(line); line = ""; }
    else line += ch;
  }

  // watchdog: lost contact while spinning -> stop
  if (throttle_us > US_MIN && millis() - last_cmd_ms > CMD_TIMEOUT_MS) {
    setThrottle(US_MIN);
    Serial.println("# stop: no command for 500 ms");
  }

  if (nau.available()) {
    int32_t raw = nau.read();
    float g = (raw - tare_raw) / counts_per_g;
    Serial.printf("%lu,%d,%ld,%.2f\n", millis(), throttle_us, (long)raw, g);
  }
}
