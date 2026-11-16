import LidarrAPI from '@server/api/servarr/lidarr';
import MusicBrainzAPI from '@server/api/musicbrainz';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

/**
 * Music search/discover/request.
 *
 * Seerr's main request pipeline (Media/MediaRequest entities, the
 * approval queue, 4K duplicate handling, etc.) is built entirely around
 * TMDB movie/TV ids, so this intentionally does not try to bolt music onto
 * it. Instead this is the same "direct add" relationship Seerr already has
 * with Radarr/Sonarr at the API level: search MusicBrainz for an artist,
 * then ask the default Lidarr server to look that artist up (matched by
 * MusicBrainz id) and add+monitor it, which makes Lidarr itself go search
 * for and grab the albums. There's no Seerr-side request/approval record
 * for music -- "requested" status is always read live from Lidarr.
 */

const musicRoutes = Router();

function getDefaultLidarr() {
  const settings = getSettings();
  const lidarrSettings =
    settings.lidarr.find((l) => l.isDefault && !l.is4k) ?? settings.lidarr[0];

  if (!lidarrSettings) {
    return undefined;
  }

  return {
    settings: lidarrSettings,
    api: new LidarrAPI({
      apiKey: lidarrSettings.apiKey,
      url: LidarrAPI.buildUrl(lidarrSettings, '/api/v1'),
    }),
  };
}

musicRoutes.get('/search', async (req, res, next) => {
  const query = (req.query.query as string | undefined) ?? '';

  try {
    const musicbrainz = new MusicBrainzAPI();
    const artists = await musicbrainz.searchArtists(query);

    return res.status(200).json({
      results: artists.map((artist) => ({
        mbid: artist.id,
        name: artist.name,
        type: artist.type,
        disambiguation: artist.disambiguation,
        country: artist.country,
      })),
    });
  } catch (e) {
    logger.error('Failed to search MusicBrainz', {
      label: 'Music',
      message: e.message,
    });
    next({ status: 500, message: 'Failed to search for artists' });
  }
});

musicRoutes.get<{ mbid: string }>('/artist/:mbid', async (req, res, next) => {
  try {
    const musicbrainz = new MusicBrainzAPI();
    const artist = await musicbrainz.getArtist(req.params.mbid);

    let alreadyAdded = false;
    const lidarr = getDefaultLidarr();
    if (lidarr) {
      try {
        const existing = await lidarr.api.getArtists();
        alreadyAdded = existing.some(
          (a) => a.foreignArtistId === req.params.mbid
        );
      } catch (e) {
        // Don't fail the whole artist page just because the live Lidarr
        // status check failed -- the page still works, it just can't show
        // whether this artist has already been added.
        logger.warn('Failed to check Lidarr for an existing artist', {
          label: 'Music',
          message: e.message,
        });
      }
    }

    return res.status(200).json({
      mbid: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation,
      type: artist.type,
      country: artist.country,
      releaseGroups: (artist['release-groups'] ?? [])
        .filter((rg) => rg['primary-type'] === 'Album')
        .sort((a, b) =>
          (b['first-release-date'] ?? '').localeCompare(
            a['first-release-date'] ?? ''
          )
        )
        .map((rg) => ({
          id: rg.id,
          title: rg.title,
          firstReleaseDate: rg['first-release-date'],
        })),
      canRequest: !!lidarr,
      alreadyAdded,
    });
  } catch (e) {
    logger.error('Failed to retrieve MusicBrainz artist', {
      label: 'Music',
      message: e.message,
    });
    next({ status: 500, message: 'Failed to retrieve artist' });
  }
});

musicRoutes.post(
  '/request',
  isAuthenticated(Permission.REQUEST),
  async (req, res, next) => {
    const lidarr = getDefaultLidarr();

    if (!lidarr) {
      return next({
        status: 412,
        message: 'No Lidarr server is configured',
      });
    }

    const { mbid } = req.body as { mbid: string };

    try {
      const lookup = await lidarr.api.lookupArtistByMbid(mbid);

      if (!lookup) {
        return next({
          status: 404,
          message: "Lidarr's metadata provider has no match for this artist",
        });
      }

      if (lookup.id) {
        // Already exists in Lidarr -- nothing to do, just report current state.
        return res.status(200).json({ alreadyAdded: true });
      }

      const metadataProfiles = await lidarr.api.getMetadataProfiles();

      const added = await lidarr.api.addArtist({
        artist: lookup,
        qualityProfileId: lidarr.settings.activeProfileId,
        metadataProfileId: metadataProfiles[0]?.id ?? 1,
        rootFolderPath: lidarr.settings.activeDirectory,
        tags: lidarr.settings.tags,
      });

      logger.info(`Requested artist "${added.artistName}" via Lidarr`, {
        label: 'Music',
        userId: req.user?.id,
      });

      return res.status(201).json({ alreadyAdded: false });
    } catch (e) {
      logger.error('Failed to request artist via Lidarr', {
        label: 'Music',
        message: e.message,
      });
      next({ status: 500, message: 'Failed to add artist to Lidarr' });
    }
  }
);

export default musicRoutes;
