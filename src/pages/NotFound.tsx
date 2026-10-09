import { NotFoundState } from '../components/NotFoundState';

export default function NotFound(_props: { params: Record<string, string> }) {
  return <NotFoundState heading="h1" />;
}
