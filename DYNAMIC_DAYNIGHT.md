# Dynamic Day/Night Terminator Implementation

## Overview
The globe now features a real-time day/night terminator that accurately reflects which parts of Earth are in darkness based on the current date and time. The terminator updates every second to show the actual position of the sun.

## How It Works

### 1. Sun Position Calculation (`calculateSunDirection`)
Located in `src/renderer/lib/globe.ts`, this function calculates the sun's position using a simplified solar position algorithm:

- **Solar Declination**: Calculates the sun's north-south position (varies between ±23.5° throughout the year)
- **Hour Angle**: Determines the sun's east-west position based on UTC time
- **Coordinate Conversion**: Converts celestial coordinates to a 3D direction vector

The algorithm accounts for:
- Seasonal variations (solstices and equinoxes)
- Time of day (rotates around Earth every 24 hours)
- Earth's axial tilt (23.5°)

### 2. Dynamic Lighting Components

#### `DynamicSunLight` Component
- Updates the Three.js directional light position every second
- Positions the light source to match the calculated sun direction
- Provides realistic lighting that follows the actual day/night cycle

#### `Earth` Component Updates
- Stores a reference to the shader uniform for light direction
- Uses `useFrame` hook to update the shader uniform every second
- Blends day texture and night lights texture based on illumination

### 3. Shader Integration
The custom shader in the Earth material:
- Compares each point's surface normal with the sun direction
- Smoothly transitions between day and night using `smoothstep`
- Shows city lights (emissive map) only on the dark side

## Real-Time Updates
Both the lighting and shader update every second (configurable), providing:
- Accurate representation of current global time
- Smooth transitions as the terminator moves
- Minimal performance impact (updates only once per second)

## Testing
Comprehensive tests verify:
- Correct sun positions for equinoxes and solstices
- Proper seasonal variations in declination
- Different sun positions throughout the day
- Normalized direction vectors

## Visual Result
The night/day border now:
- ✅ Moves in real-time based on actual UTC time
- ✅ Reflects seasonal variations (sun more north in summer, more south in winter)
- ✅ Shows accurate terminator position for any time of day
- ✅ Smoothly blends city lights on the dark side

## Accuracy Note
This implementation uses a simplified solar position algorithm that provides accuracy within a few degrees, which is more than sufficient for visualization purposes. For scientific applications requiring higher precision, the algorithm could be enhanced with additional corrections for the equation of time and atmospheric refraction.

## Coordinate System
The implementation correctly maps solar positions to Three.js coordinates:
- **X-axis**: Points toward Greenwich meridian (0° longitude)
- **Y-axis**: Points toward North Pole (positive = north, negative = south)
- **Z-axis**: Points toward 90° West longitude
- **Hour Angle**: Increases 15° per hour as time progresses from UTC noon
  - 12:00 UTC → Sun at 0° (Greenwich)
  - 18:00 UTC → Sun at -90° (90° West, illuminates Central/North America)
  - 00:00 UTC → Sun at -180° (International Date Line)
  - 06:00 UTC → Sun at 90° (90° East, illuminates Asia)

## Validation
At 10 AM PST (18:00 UTC):
- Sun is overhead at approximately -90° longitude (Central America)
- West coast of North America (-120° to -125°) is in full daylight ✓
- The night lights texture appears only on the opposite side of Earth ✓
