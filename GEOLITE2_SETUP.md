# Setting Up GeoLite2 Databases

VisTracer uses MaxMind's GeoLite2 databases to provide location and network information for IP addresses encountered during traceroutes. While the application works without these databases, having them installed enables rich geographic visualization and network details.

## What You Get With GeoLite2

- **City Database**: Provides latitude/longitude coordinates, city names, and country information
- **ASN Database**: Provides Autonomous System Numbers (ASN) and organization names

## Quick Setup

### Option 1: Automatic Detection (Recommended)

1. Download the databases from MaxMind (see below)
2. Place the `.mmdb` files in the `assets/` directory:
   ```
   vistracer-codex/
   └── assets/
       ├── GeoLite2-City.mmdb
       └── GeoLite2-ASN.mmdb
   ```
3. Restart VisTracer

The application will automatically detect and load the databases on startup.

### Option 2: Custom Location

1. Download the databases from MaxMind
2. Place them anywhere on your system
3. Launch VisTracer
4. When you see the warning banner, click **Configure**
5. Enter the full paths to your `.mmdb` files:
   - City Database: `/path/to/GeoLite2-City.mmdb`
   - ASN Database: `/path/to/GeoLite2-ASN.mmdb`
6. Click **Save & Apply**

No restart required! The databases will be loaded immediately.

## Downloading GeoLite2 Databases

### Step 1: Create MaxMind Account

1. Go to [MaxMind's GeoLite2 signup page](https://www.maxmind.com/en/geolite2/signup)
2. Create a free account
3. Verify your email address

### Step 2: Generate License Key

1. Log in to your MaxMind account
2. Navigate to **Account** → **Manage License Keys**
3. Click **Generate new license key**
4. Give it a name (e.g., "VisTracer")
5. Select **No** for "Will this key be used for GeoIP Update?"
6. Click **Confirm**
7. **Important**: Save the license key shown - you won't be able to see it again!

### Step 3: Download Databases

#### Via Web Interface

1. Go to **Account** → **Download Files**
2. Find **GeoLite2 City** and click **Download GZIP**
3. Find **GeoLite2 ASN** and click **Download GZIP**
4. Extract the `.tar.gz` or `.zip` files
5. Inside each archive, find the `.mmdb` file

#### Via Command Line (macOS/Linux)

```bash
# Set your license key
LICENSE_KEY="your_license_key_here"

# Download City database
curl -o GeoLite2-City.tar.gz \
  "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${LICENSE_KEY}&suffix=tar.gz"

# Download ASN database
curl -o GeoLite2-ASN.tar.gz \
  "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=${LICENSE_KEY}&suffix=tar.gz"

# Extract
tar -xzf GeoLite2-City.tar.gz
tar -xzf GeoLite2-ASN.tar.gz

# Move to VisTracer assets directory (adjust path as needed)
cp GeoLite2-City_*/GeoLite2-City.mmdb /path/to/vistracer-codex/assets/
cp GeoLite2-ASN_*/GeoLite2-ASN.mmdb /path/to/vistracer-codex/assets/
```

#### Via Command Line (Windows PowerShell)

```powershell
# Set your license key
$LICENSE_KEY = "your_license_key_here"

# Download City database
Invoke-WebRequest -Uri "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=$LICENSE_KEY&suffix=tar.gz" -OutFile "GeoLite2-City.tar.gz"

# Download ASN database
Invoke-WebRequest -Uri "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=$LICENSE_KEY&suffix=tar.gz" -OutFile "GeoLite2-ASN.tar.gz"

# Extract using 7-Zip or similar tool
# Then copy .mmdb files to assets directory
```

## Verifying Installation

### Check the Footer

Look at the bottom of the VisTracer window:

- ✅ **"GeoLite2 loaded (updated [date])"** - Both databases loaded successfully
- ⚠️ **"GeoLite2 partially loaded"** - One database is missing
- ⚠️ **"GeoLite2 database not configured"** - No databases found

### Check the Settings

1. Click the **Configure** button in the warning banner (if shown)
2. Look at the status indicators next to each database:
   - 🟢 **Loaded** - Database is working
   - 🟡 **Not Found** - Database file doesn't exist at the specified path
   - 🔴 **Error** - Database file exists but couldn't be loaded

## Updating Databases

MaxMind updates the GeoLite2 databases regularly (typically weekly). To update:

1. Download the latest databases (see steps above)
2. Replace the old `.mmdb` files with the new ones
3. In VisTracer, open the settings modal
4. Click **Save & Apply** (even without changing paths)

This will reload the databases with the new data.

## Troubleshooting

### Warning Banner Still Shows After Installation

- **Check file paths**: Make sure the paths in settings exactly match where you placed the files
- **Check file names**: Files must be named exactly `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb`
- **Check permissions**: Ensure VisTracer has read access to the files
- **Reload**: Click **Save & Apply** in the settings modal

### "Error" Status for a Database

- **Corrupted file**: Try re-downloading the database
- **Wrong file**: Make sure you downloaded the correct edition (City or ASN)
- **Outdated format**: Very old databases might not be compatible - download the latest version

### Application Won't Start After Installing Databases

This shouldn't happen! The application is designed to work with or without databases. If you encounter this:

1. Remove the `.mmdb` files from the assets directory
2. Start the application
3. Try installing the databases again, or use Option 2 (custom location)

### Performance Issues

The databases are memory-mapped and should be fast, but:

- **Large memory usage**: Each database uses ~60-70 MB of RAM when loaded
- **First lookup slow**: The first lookup after loading may take longer
- **Consider SSD**: Databases on SSD will be faster than HDD

## Privacy & Licensing

### GeoLite2 License

- GeoLite2 databases are free but require attribution
- They are less accurate than MaxMind's commercial GeoIP2 databases
- See [MaxMind's license terms](https://www.maxmind.com/en/geolite2/eula)

### Privacy

- All geo lookups happen **locally** on your machine
- No data is sent to MaxMind or any external service
- Lookups are cached to electron-store for performance

### Accuracy

- **City location**: Typically accurate to within 50-100km
- **Country**: Very accurate (>99%)
- **ASN**: Highly accurate
- Note: Location data represents the ISP's registration location, not the physical device location

## Alternative: Commercial GeoIP2 Databases

If you need higher accuracy, MaxMind offers commercial GeoIP2 databases:

1. Purchase a GeoIP2 subscription from MaxMind
2. Download the `.mmdb` files
3. Use the same setup process as GeoLite2
4. The format is compatible - VisTracer will work with either

## Need Help?

- Check the [MaxMind GeoLite2 documentation](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)
- Review the [VisTracer README](./README.md)
- Open an issue on the project repository

---

**Note**: This application is not affiliated with MaxMind. GeoLite2 is a trademark of MaxMind, Inc.
