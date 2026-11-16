import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.ArtistDetails', {
  requestartist: 'Request',
  requested: 'Already Requested',
  requesting: 'Requesting…',
  requestSuccess: '{artist} requested successfully!',
  requestError: 'Something went wrong requesting {artist}.',
  noLidarr: 'No Lidarr server is configured, so artists cannot be requested.',
  albums: 'Albums',
});

interface ArtistDetailsResponse {
  mbid: string;
  name: string;
  disambiguation?: string;
  type?: string;
  country?: string;
  releaseGroups: { id: string; title: string; firstReleaseDate?: string }[];
  canRequest: boolean;
  alreadyAdded: boolean;
}

const ArtistDetails = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const mbid = router.query.mbid as string | undefined;

  const [artist, setArtist] = useState<ArtistDetailsResponse>();
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);

  useEffect(() => {
    if (!mbid) {
      return;
    }

    setIsLoading(true);
    axios
      .get<ArtistDetailsResponse>(`/api/v1/music/artist/${mbid}`)
      .then((response) => setArtist(response.data))
      .finally(() => setIsLoading(false));
  }, [mbid]);

  const request = async () => {
    if (!artist) {
      return;
    }

    setIsRequesting(true);
    try {
      await axios.post('/api/v1/music/request', { mbid: artist.mbid });
      setArtist({ ...artist, alreadyAdded: true });
      addToast(
        intl.formatMessage(messages.requestSuccess, { artist: artist.name }),
        { appearance: 'success' }
      );
    } catch {
      addToast(
        intl.formatMessage(messages.requestError, { artist: artist.name }),
        { appearance: 'error' }
      );
    } finally {
      setIsRequesting(false);
    }
  };

  if (isLoading || !artist) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <>
      <PageTitle title={artist.name} />
      <div className="mb-5 mt-1 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Header subtext={artist.disambiguation}>{artist.name}</Header>
          <div className="mt-1 text-sm uppercase text-gray-500">
            {[artist.type, artist.country].filter(Boolean).join(' · ')}
          </div>
        </div>
        {artist.canRequest ? (
          <Button
            buttonType={artist.alreadyAdded ? 'default' : 'primary'}
            disabled={artist.alreadyAdded || isRequesting}
            onClick={request}
          >
            {artist.alreadyAdded
              ? intl.formatMessage(messages.requested)
              : isRequesting
              ? intl.formatMessage(messages.requesting)
              : intl.formatMessage(messages.requestartist)}
          </Button>
        ) : (
          <span className="text-sm text-gray-400">
            {intl.formatMessage(messages.noLidarr)}
          </span>
        )}
      </div>
      <h2 className="mb-2 text-xl font-bold text-white">
        {intl.formatMessage(messages.albums)}
      </h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {artist.releaseGroups.map((rg) => (
          <li
            key={rg.id}
            className="flex flex-col rounded-lg bg-gray-800 p-4"
          >
            <span className="font-medium text-white">{rg.title}</span>
            {rg.firstReleaseDate && (
              <span className="text-sm text-gray-400">
                {rg.firstReleaseDate.slice(0, 4)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
};

export default ArtistDetails;
