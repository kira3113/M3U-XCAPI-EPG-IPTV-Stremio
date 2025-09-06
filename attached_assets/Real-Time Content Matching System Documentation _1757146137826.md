# Real-Time Content Matching System Documentation

# **Real-Time Content Matching System Documentation**

## **Overview**

The Real-Time Content Matching System is the core engine that bridges Stremio's IMDB-based content requests with your IPTV provider's content library. It performs intelligent, on-demand content discovery without requiring pre-synchronization of large content libraries.

## **System Architecture**

```
Stremio Request (IMDB ID) → Content Matching Engine → IPTV Provider → Stream URL

```

### **Key Components**

1. **IMDB Request Parser** - Extracts content identifiers and episode information
2. **OMDb API Integration** - Resolves accurate titles from IMDB IDs
3. **IPTV Library Fetcher** - Retrieves content from your IPTV provider
4. **Fuzzy Matching Engine** - Intelligently matches titles across different formats
5. **Stream URL Generator** - Creates direct streaming URLs

## **How It Works**

### **1. Request Processing**

When Stremio requests content, the system receives requests in these formats:

**Movies:**

```
🔍 Searching IPTV library for IMDB ID: tt9603208

```

**TV Series Episodes:**

```
🔍 Searching IPTV library for IMDB ID: tt13623632:1:1
(Format: imdbId:season:episode)

```

### **2. Content Discovery Flow**

### **Movies Workflow**

```
graph TD
    A[Stremio Request] --> B[Parse IMDB ID]
    B --> C[Check Local Cache]
    C --> D{Found?}
    D -->|No| E[Fetch IPTV Library]
    E --> F[Call OMDb API]
    F --> G[Get Official Title]
    G --> H[Fuzzy Match Search]
    H --> I[Generate Stream URL]
    I --> J[Return to Stremio]
    D -->|Yes| J

```

### **TV Series Workflow**

```
graph TD
    A[Stremio Request] --> B[Parse IMDB ID + Episode Info]
    B --> C[Extract Season/Episode Numbers]
    C --> D[Fetch Series Library]
    D --> E[Call OMDb API for Title]
    E --> F[Match Series Name]
    F --> G[Get Series Episodes Data]
    G --> H[Find Specific Episode]
    H --> I[Generate Episode Stream URL]
    I --> J[Return to Stremio]

```

### **3. OMDb API Integration**

The system uses OMDb API to get accurate, official titles:

```
// Example API call
const response = await fetch(`http://www.omdbapi.com/?apikey=${apiKey}&i=${imdbId}&plot=short`);
const data = await response.json();
// Result
console.log(`🎬 OMDb found: ${data.Title} (${data.Year})`);
// Output: "🎬 OMDb found: Mission: Impossible - The Final Reckoning (2025)"

```

### **4. Fuzzy Matching Algorithm**

The fuzzy matching engine handles variations in movie titles:

### **Title Normalization**

```
private normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')           // Remove special chars
    .replace(/\s+/g, ' ')               // Collapse whitespace
    .replace(/\b(19|20)\d{2}\b/g, '')   // Remove years
    .replace(/\b(hdtv|1080p|720p|hd|4k)\b/gi, '') // Remove quality tags
    .replace(/\b(dubbed|hindi|english)\b/gi, '')   // Remove language tags
    .trim();
}

```

### **Similarity Scoring**

```
private fuzzyMatch(title1: string, title2: string, threshold: number = 0.8): boolean {
  const words1 = normalizedTitle1.split(/\s+/).filter(w => w.length > 2);
  const words2 = normalizedTitle2.split(/\s+/).filter(w => w.length > 2);

  const matches = words1.filter(word => words2.includes(word)).length;
  const similarity = matches / Math.max(words1.length, words2.length);

  return similarity >= threshold;
}

```

## **Real-Time Processing Examples**

### **Movie Matching Example**

**Input:** Stremio requests `tt9603208`

**Process:**

1. **OMDb Lookup:** Gets "Mission: Impossible - The Final Reckoning (2025)"
2. **IPTV Search:** Searches through 39,686 movies
3. **Best Match:** Finds "Mission: Impossible - The Final Reckoning HD" (score: 1.00)
4. **Stream Generation:** Creates direct URL with proper container extension

**Console Output:**

```
🔍 Searching IPTV library for IMDB ID: tt9603208
🎬 No stored content found, searching IPTV provider for movie...
📊 Total movies in IPTV library: 39686
🎬 OMDb found: Mission: Impossible - The Final Reckoning (2025)
🎯 Searching IPTV library for: "Mission: Impossible - The Final Reckoning"
🎯 Best match found: "Mission: Impossible - The Final Reckoning HD" (score: 1.00)
✅ Added stream for: Mission: Impossible - The Final Reckoning HD

```

### **TV Series Episode Matching Example**

**Input:** Stremio requests `tt13623632:1:1` (Season 1, Episode 1)

**Process:**

1. **Parse Request:** Extracts base IMDB ID and episode info
2. **OMDb Lookup:** Gets "Alien: Earth (2025–)"
3. **Series Search:** Finds "Alien Earth" in 7,563 series
4. **Episode Resolution:** Navigates to Season 1, Episode 1
5. **Stream Generation:** Creates episode-specific URL

**Console Output:**

```
🔍 Searching IPTV library for IMDB ID: tt13623632:1:1
📺 No stored content found, searching IPTV provider for series...
🎯 Looking for series tt13623632, Season 1, Episode 1
📊 Total series in IPTV library: 7563
🎬 OMDb found: Alien: Earth (2025–)
🎯 Searching IPTV library for series: "Alien: Earth"
🎯 Best series match found: "Alien Earth" (score: 1.00)
📺 Series has episodes data, looking for S1E1
✅ Added stream for: Alien Earth S1E1

```

## **Performance Characteristics**

### **Speed Optimizations**

1. **Smart IPTV Fetching:** Retrieves entire libraries once per session
2. **OMDb Caching:** Reduces redundant API calls
3. **Parallel Processing:** Handles multiple requests simultaneously
4. **Threshold-based Matching:** Early exit when perfect matches found

### **Accuracy Features**

1. **Official Title Resolution:** OMDb API ensures correct titles
2. **Multi-format Support:** Handles various title formats and languages
3. **Quality-aware Matching:** Prefers HD/4K versions when available
4. **Container Extension Detection:** Proper file format handling

## **Error Handling**

### **Graceful Degradation**

```
// If OMDb fails, fallback to IMDB ID-based search
if (!actualTitle) {
  console.log(`❌ Could not get movie title from OMDb for ${id}`);
  // Continue with alternative matching strategies
}

```

### **Comprehensive Logging**

```
// Detailed progress tracking
console.log(`📊 Total movies in IPTV library: ${vodStreams.length}`);
console.log(`🎯 Best match found: "${bestMatch.name}" (score: ${bestScore.toFixed(2)})`);
console.log(`✅ Added stream for: ${bestMatch.name}`);

```

## **API Integration Points**

### **Xtream API Endpoints**

- **Movies:** `/player_api.php?action=get_vod_streams`
- **Series:** `/player_api.php?action=get_series`
- **Series Info:** `/player_api.php?action=get_series_info&series_id={id}`

### **OMDb API**

- **Endpoint:** `http://www.omdbapi.com/?apikey={key}&i={imdbId}`
- **Purpose:** Official title resolution and metadata

### **Stream URL Formats**

```
// Movie streams
buildVodUrl(streamId, extension): string {
  return `${baseUrl}/movie/${username}/${password}/${streamId}.${extension}`;
}
// TV series episodes
buildSeriesUrl(streamId, extension): string {
  return `${baseUrl}/series/${username}/${password}/${streamId}.${extension}`;
}

```

## **Configuration Options**

### **Matching Thresholds**

```
// Configurable similarity threshold
private fuzzyMatch(title1: string, title2: string, threshold: number = 0.8): boolean

```

### **API Rate Limiting**

```
// Built-in delays to respect provider limits
await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay

```

### **Quality Preferences**

```
// Automatic quality detection and preference
const qualityTags = ['4K', 'HD', '1080p', '720p'];

```

## **Benefits**

1. **No Pre-sync Required:** Content discovered on-demand
2. **Always Fresh:** Real-time access to newly added content
3. **High Accuracy:** OMDb API ensures precise matching
4. **Smart Caching:** Optimized for repeated requests
5. **Fault Tolerant:** Graceful handling of API failures
6. **Language Agnostic:** Handles international content variations

## **Monitoring and Debugging**

### **Console Output Interpretation**

- **🔍** = Search operations
- **📊** = Statistics and counts
- **🎬** = OMDb API results
- **🎯** = Matching operations
- **✅** = Successful operations
- **❌** = Errors or failures

### **Performance Metrics**

- **Library Size:** Tracks total content available
- **Match Scores:** Quantifies matching accuracy
- **Response Times:** Monitors API performance
- **Success Rates:** Tracks successful stream generation

This real-time content matching system provides the intelligence needed to seamlessly bridge Stremio's standardized content requests with your IPTV provider's unique content library structure.