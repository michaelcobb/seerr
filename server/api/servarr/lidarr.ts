import ServarrBase from './base';

/**
 * Minimal Lidarr API client.
 *
 * Lidarr's v1 API exposes the same system/status, qualityProfile, rootfolder,
 * tag and command endpoints that Radarr/Sonarr expose on v3, so everything
 * this settings card needs (connection test, profile list, root folder list,
 * tag list) is already provided by ServarrBase. This class exists mainly to
 * give Lidarr its own apiName/cacheName so its cached lookups and log lines
 * don't collide with Radarr's.
 *
 * NOTE: there is intentionally no request-related logic here (no
 * addAlbum/removeAlbum, no album lookups). Seerr's request pipeline is
 * TMDB-based and only understands MediaType.MOVIE and MediaType.TV, so a
 * real "request an album" flow would need a new media type, a
 * MusicBrainz-based discover/search UI, and new DB columns -- out of scope
 * for this settings card, which only lets an admin register a Lidarr
 * instance and verify connectivity/profiles/folders from Seerr.
 */
class LidarrAPI extends ServarrBase<Record<string, never>> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'lidarr', apiName: 'Lidarr' });
  }
}

export default LidarrAPI;
