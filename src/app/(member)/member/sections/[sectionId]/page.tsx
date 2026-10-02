import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { Metadata } from 'next';
import { MessageBoard } from '@/components/member/section/MessageBoard';

export const metadata: Metadata = {
  title: 'Section Board',
};

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ sectionId: string }>;
}

export default async function SectionBoardPage({ params }: PageProps) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) return null;

  const { sectionId } = await params;

  const member = await prisma.member.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });

  if (!member) return null;

  const membership = await prisma.memberSection.findFirst({
    where: {
      memberId: member.id,
      sectionId,
    },
    include: {
      section: true,
    },
  });

  if (!membership) {
    return (
      <div className="p-8 text-center text-destructive">
        You are not a member of this section.
      </div>
    );
  }

  const messages = await prisma.sectionMessage.findMany({
    where: { sectionId },
    include: {
      member: {
        select: {
          firstName: true,
          lastName: true,
          profilePhoto: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 250,
  });

  const serializedMessages = messages.reverse().map((message) => ({
    id: message.id,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    member: message.member,
  }));

  return (
    <div className="container mx-auto py-8">
      <MessageBoard
        sectionId={sectionId}
        sectionName={membership.section.name}
        initialMessages={serializedMessages}
      />
    </div>
  );
}
