# Thrust stand

Single-screen control and logging for a small FPV motor thrust stand. Static `index.html` + `app.js`; open `index.html` in Chrome (Web Serial). Firmware in `firmware/thrust_stand`.

## Hardware
Adafruit ESP32-S3 Feather, Adafruit NAU7802 (STEMMA QT), 5 kg S-type load cell, Hobbywing Skywalker 60A V2 (signal on pin 5), 6S.

## Firmware
Easiest: open the page in Chrome, click Flash firmware, pick the board. If it fails to connect, hold BOOT, tap RESET, release BOOT and try again; press RESET after flashing. Binaries in `firmware/bin` are built by the GitHub Action on every firmware change.

Manual: Arduino IDE, esp32 core 3.x, Adafruit NAU7802 library. Commands at 115200: `t<us>`, `s`, `z`, `c<grams>`, `p`. Streams `ms,throttle_us,raw,thrust_g` at 80 Hz. Calibration is stored in flash.

Above min throttle, any gap in commands longer than 500 ms stops the motor. The UI resends throttle every 100 ms while armed.

## UI
- Arm, then slider or numeric entry. Limit caps the slider.
- Stop: button, Esc, or Space.
- Sweep steps from start to end and averages the second half of each dwell.
- Export log writes every sample; export sweep writes one row per step.
