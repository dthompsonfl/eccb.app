import { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Music,
  Plus,
  Search,
  Download,
} from 'lucide-react';
import { type MusicPieceWithRelations } from '@/components/admin/MusicLibraryTable';
import { RealTimeMusicLibrary } from '@/components/admin/RealTimeMusicLibrary';


import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
export const metadata: Metadata = {
  title: 'Music Library',
};

interface SearchParams {
  search?: string;
  genre?: string;
  difficulty?: string;
  status?: string;
  sort?: string;
  order?: string;
  page?: string | number;
}

type SortField = 'title' | 'composer' | 'createdAt' | 'difficulty';
type SortOrder = 'asc' | 'desc';

export default async function AdminMusicPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePermission(MUSIC_VIEW_ALL);
  const params = await searchParams;

  const search = params.search || '';
  const genre = params.genre || '';
  const difficulty = params.difficulty || '';
  const status = params.status || '';
  const sortField = (params.sort as SortField) || 'title';
  const sortOrder = (params.order as SortOrder) || 'asc';
  const page = typeof params.page === 'number' ? params.page : parseInt(params.page || '1');
  const limit = 20;

  // Build where clause
  const where: Record<string, unknown> = {};

  // Filter by deleted/archived status
  if (status === 'trash') {
    where.deletedAt = { not: null };
  } else if (status === 'archived') {
    where.isArchived = true;
    where.deletedAt = null;
  } else if (status === 'active' || !status) {
    where.isArchived = false;
    where.deletedAt = null;
  }
  // 'all' shows everything (no filter)

  // Filter by genre
  if (genre) {
    where.genre = genre;
  }

  // Filter by difficulty
  if (difficulty) {
    where.difficulty = difficulty;
  }

  // Search by title, composer, or arranger
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { subtitle: { contains: search, mode: 'insensitive' } },
      { composer: { fullName: { contains: search, mode: 'insensitive' } } },
      { arranger: { fullName: { contains: search, mode: 'insensitive' } } },
      { catalogNumber: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Build orderBy clause
  const orderBy: Record<string, unknown> = {};
  switch (sortField) {
    case 'title':
      orderBy.title = sortOrder;
      break;
    case 'composer':
      orderBy.composer = { fullName: sortOrder };
      break;
    case 'createdAt':
      orderBy.createdAt = sortOrder;
      break;
    case 'difficulty':
      orderBy.difficulty = sortOrder;
      break;
    default:
      orderBy.title = 'asc';
  }

  // Get unique genres for filter dropdown
  const genres = await prisma.musicPiece.findMany({
    where: { deletedAt: null, genre: { not: null } },
    select: { genre: true },
    distinct: ['genre'],
  });
  const uniqueGenres = genres
    .map((g) => g.genre)
    .filter((g): g is string => g !== null)
    .sort();

  // Fetch paginated results with counts
  const [pieces, total, stats] = await Promise.all([
    prisma.musicPiece.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        composer: true,
        arranger: true,
        publisher: true,
        files: {
          where: { isArchived: false },
        },
        _count: {
          select: {
            assignments: true,
            eventMusic: true,
          },
        },
      },
    }),
    prisma.musicPiece.count({ where }),
    prisma.musicPiece.groupBy({
      by: ['isArchived', 'deletedAt'],
      where: {},
      _count: true,
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  // Calculate stats
  const archivedCount = stats.find((s) => s.isArchived && !s.deletedAt)?._count || 0;
  const activeCount = stats.find((s) => !s.isArchived && !s.deletedAt)?._count || 0;
  const trashCount =
    stats.reduce((sum, s) => (s.deletedAt ? sum + s._count : sum), 0) || 0;

  // Helper to build filter URL
  const buildFilterUrl = (overrides: Partial<SearchParams> = {}) => {
    const params = new URLSearchParams();
    const newSearch = overrides.search !== undefined ? overrides.search : search;
    const newGenre = overrides.genre !== undefined ? overrides.genre : genre;
    const newDifficulty = overrides.difficulty !== undefined ? overrides.difficulty : difficulty;
    const newStatus = overrides.status !== undefined ? overrides.status : status;
    const newSort = overrides.sort !== undefined ? overrides.sort : sortField;
    const newOrder = overrides.order !== undefined ? overrides.order : sortOrder;
    const newPage =
      typeof overrides.page === 'number'
        ? overrides.page
        : overrides.page
          ? parseInt(overrides.page)
          : 1;

    if (newSearch) params.set('search', newSearch);
    if (newGenre) params.set('genre', newGenre);
    if (newDifficulty) params.set('difficulty', newDifficulty);
    if (newStatus && newStatus !== 'active') params.set('status', newStatus);
    if (newSort !== 'title') params.set('sort', newSort);
    if (newOrder !== 'asc') params.set('order', newOrder);
    if (newPage > 1) params.set('page', newPage.toString());

    const queryString = params.toString();
    return `/admin/music${queryString ? `?${queryString}` : ''}`;
  };

  // Helper to build export URL
  const buildExportUrl = () => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (genre) params.set('genre', genre);
    if (difficulty) params.set('difficulty', difficulty);
    if (status && status !== 'active') params.set('status', status);

    const queryString = params.toString();
    return `/api/admin/music/export${queryString ? `?${queryString}` : ''}`;
  };

  // Helper to render sort icon (kept for future pagination enhancements)
  // const getSortIcon = (field: SortField) => {
  //   if (sortField !== field) return <ArrowUpDown className="ml-1 h-4 w-4" />;
  //   return sortOrder === 'asc' ? (
  //     <ArrowUp className="ml-1 h-4 w-4" />
  //   ) : (
  //     <ArrowDown className="ml-1 h-4 w-4" />
  //   );
  // };


  // Define difficulty colors and labels
  const difficultyColors: Record<string, string> = {
    GRADE_1: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    GRADE_2: 'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-300',
    GRADE_3: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
    GRADE_4: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
    GRADE_5: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    GRADE_6: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  };

  const difficultyLabels: Record<string, string> = {
    GRADE_1: 'Grade 1',
    GRADE_2: 'Grade 2',
    GRADE_3: 'Grade 3',
    GRADE_4: 'Grade 4',
    GRADE_5: 'Grade 5',
    GRADE_6: 'Grade 6',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Music Library</h1>
          <p className="text-muted-foreground">Manage the band's music catalog.</p>
        </div>
        <div className="flex gap-2">
          <a href={buildExportUrl()}>
            <Button variant="outline" type="button">
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
          </a>
          <Button asChild>
            <Link href="/admin/music/new">
              <Plus className="mr-2 h-4 w-4" />
              Add Music
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Pieces</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount + archivedCount + trashCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">With Files</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {pieces.filter((p) => p.files.length > 0).length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Archived</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{archivedCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Trash</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{trashCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Music Catalog</CardTitle>
          <CardDescription>Search and filter the music library</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col sm:flex-row gap-4 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                name="search"
                placeholder="Search by title, composer, arranger, or catalog #..."
                defaultValue={search}
                className="pl-9"
              />
            </div>
            <Select name="genre" defaultValue={genre}>
              <SelectTrigger id="genre" name="genre" className="w-[180px]">
                <SelectValue placeholder="All Genres" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Genres</SelectItem>
                {uniqueGenres.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select name="difficulty" defaultValue={difficulty}>
              <SelectTrigger id="difficulty" name="difficulty" className="w-[150px]">
                <SelectValue placeholder="All Levels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                {Object.entries(difficultyLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select name="status" defaultValue={status || ''}>
              <SelectTrigger id="status" name="status" className="w-[150px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
                <SelectItem value="trash">Trash</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit">Filter</Button>
          </form>

          {pieces.length === 0 ? (
            <div className="text-center py-12">
              <Music className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No music found</h3>
              <p className="text-muted-foreground">
                {search || genre || difficulty || status
                  ? 'Try adjusting your search or filters'
                  : 'Add your first piece to the library'}
              </p>
              {!search && !genre && !difficulty && !status && (
                <Button className="mt-4" asChild>
                  <Link href="/admin/music/new">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Music
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <RealTimeMusicLibrary
              initialPieces={pieces as MusicPieceWithRelations[]}
              difficultyColors={difficultyColors}
              difficultyLabels={difficultyLabels}
            />
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Showing {(page - 1) * limit + 1} to {Math.min(page * limit, total)} of {total}{' '}
                pieces
              </p>
              <div className="flex items-center gap-2">
                <Link href={buildFilterUrl({ page: page - 1 })}>
                  <Button variant="outline" size="sm" disabled={page <= 1}>
                    Previous
                  </Button>
                </Link>
                <span className="text-sm">
                  Page {page} of {totalPages}
                </span>
                <Link href={buildFilterUrl({ page: page + 1 })}>
                  <Button variant="outline" size="sm" disabled={page >= totalPages}>
                    Next
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
