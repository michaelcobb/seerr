import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.ArtistSearch', {
  music: 'Music',
  searchArtists: 'Search for an artist…',
  noResults: 'No artists found.',
  searching: 'Searching…',
});

interface MusicSearchResult {
  mbid: string;
  name: string;
  type?: string;
  disambiguation?: string;
  country?: string;
  imageUrl?: string;
}

const ArtistSearch = () => {
  const intl = useIntl();
  const router = useRouter();
  const [query, setQuery] = useState((router.query.query as string) ?? '');
  const [results, setResults] = useState<MusicSearchResult[]>();
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setResults(undefined);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);

    const timeout = setTimeout(() => {
      axios
        .get<{ results: MusicSearchResult[] }>('/api/v1/music/search', {
          params: { query },
          signal: controller.signal,
        })
        .then((response) => setResults(response.data.results))
        .catch(() => undefined)
        .finally(() => setIsLoading(false));
    }, 400);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.music)} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.music)}</Header>
      </div>
      <div className="relative mb-6 max-w-lg">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
        </div>
        <input
          type="text"
          className="w-full rounded-md border border-gray-600 bg-gray-800 py-2 pl-10 pr-4 text-white placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          placeholder={intl.formatMessage(messages.searchArtists)}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      {isLoading && (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      )}
      {!isLoading && results && results.length === 0 && (
        <p className="text-gray-400">
          {intl.formatMessage(messages.noResults)}
        </p>
      )}
      {!isLoading && results && results.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((artist) => (
            <li key={artist.mbid}>
              <Link
                href={`/music/${artist.mbid}`}
                className="flex items-center gap-3 rounded-lg bg-gray-800 p-4 transition hover:bg-gray-700"
              >
                {artist.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={artist.imageUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-800 to-purple-600 text-white/85">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-6 w-6"
                    >
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                  </div>
                )}
                <div className="flex flex-col">
                  <span className="font-semibold text-white">
                    {artist.name}
                  </span>
                  {artist.disambiguation && (
                    <span className="text-sm text-gray-400">
                      {artist.disambiguation}
                    </span>
                  )}
                  <span className="mt-1 text-xs uppercase text-gray-500">
                    {[artist.type, artist.country]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

export default ArtistSearch;
