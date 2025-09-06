# Overview

This is a self-hostable Stremio addon that integrates IPTV services with the Stremio media player. The addon supports multiple input formats including direct M3U playlists, Xtream Codes API, and XMLTV EPG data. It provides intelligent content matching, series detection, and streaming capabilities while maintaining user privacy through token-based configuration encoding.

The addon serves as a bridge between IPTV providers and Stremio, offering features like live TV channels, movies, series catalogs, electronic program guides (EPG), and real-time content matching using OMDb API integration.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Core Framework
- **Node.js Express Server**: Main application server handling HTTP requests and serving static content
- **Stremio Addon SDK**: Official SDK for creating Stremio-compatible addons with manifest and catalog generation
- **Serverless Support**: Optional Vercel deployment configuration for serverless environments

## Configuration Management
- **Token-Based Config**: User configurations are encoded into URL tokens for privacy and portability
- **Encryption Support**: Optional AES-256-GCM encryption for sensitive configuration data using CONFIG_SECRET
- **Multiple Input Modes**: Support for direct M3U URLs and Xtream Codes API credentials

## Content Processing Pipeline
- **M3U Parser**: Processes playlist files to extract channel, movie, and series information
- **Series Detection**: Heuristic pattern matching to identify and group TV series episodes (SxxExx format)
- **Content Matching Engine**: Real-time fuzzy matching system that correlates Stremio IMDB requests with IPTV content
- **OMDb Integration**: Resolves accurate titles and metadata from IMDB IDs for improved matching

## Caching Strategy
- **Dual-Layer Caching**: LRU in-memory cache with optional Redis backend for scalability
- **Interface Caching**: Addon interfaces are cached to reduce rebuild overhead
- **Configurable TTL**: Cache expiration settings via environment variables

## Data Providers
- **Direct M3U Provider**: Fetches and parses M3U playlist files with series grouping capabilities
- **Xtream Provider**: Integrates with Xtream Codes API for JSON-based content retrieval
- **EPG Processing**: XMLTV parser for electronic program guide data with timezone offset support

## CORS Handling
- **Client-Side Preflight**: Browser-based content validation with CORS bypass
- **Server Fallback**: Proxy endpoint for handling CORS-restricted content sources
- **Prefetch API**: Dedicated endpoints for validating playlists and EPG sources

## Content Organization
- **Multi-Catalog Support**: Separate catalogs for live TV channels, movies, and TV series
- **Episode Indexing**: Direct mapping system for series episodes to enable per-episode streaming
- **Metadata Enhancement**: Logo proxy and EPG integration for rich content presentation

# External Dependencies

## Required Services
- **OMDb API**: Content metadata resolution and title matching (requires API key)
- **IPTV Provider**: Source of M3U playlists or Xtream Codes API access
- **XMLTV EPG Source**: Electronic program guide data (optional but recommended)

## Optional Infrastructure
- **Redis**: Distributed caching for multi-instance deployments
- **Vercel/Serverless**: Cloud deployment platform for serverless hosting

## Core Dependencies
- **express**: Web server framework
- **stremio-addon-sdk**: Official Stremio addon development kit
- **node-fetch**: HTTP client for external API calls
- **xml2js**: XML parsing for XMLTV EPG data
- **ioredis**: Redis client for distributed caching
- **dotenv**: Environment variable management

## Development Tools
- **nodemon**: Development server with auto-reload
- **crypto**: Built-in Node.js cryptography for config encryption