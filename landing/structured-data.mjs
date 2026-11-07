/** Shared identities for the statically rendered public site. */
export const siteURL = 'https://paprikacd.github.io/paprika/';
export const repositoryURL = 'https://github.com/paprikacd/paprika';
const url = (route) => new URL(route, siteURL).href;
const ref = (id) => ({ '@id': id });
const websiteID = `${siteURL}#website`;
const publisherID = `${siteURL}#maintainers`;
const softwareID = `${siteURL}#software`;

// JSON-LD is embedded in HTML: JSON.stringify alone does not escape </script>.
export const jsonScript = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function sharedEntities() {
  return [
    { '@type': 'Organization', '@id': publisherID, name: 'Paprika maintainers',
      url: repositoryURL, logo: url('paprika-mark.png') },
    { '@type': 'WebSite', '@id': websiteID, name: 'Paprika', url: siteURL,
      publisher: ref(publisherID), inLanguage: 'en' },
    { '@type': 'SoftwareSourceCode', '@id': softwareID, name: 'Paprika', url: siteURL,
      description: 'Open source Kubernetes application delivery operator',
      codeRepository: repositoryURL, license: 'https://www.apache.org/licenses/LICENSE-2.0',
      programmingLanguage: 'Go', runtimePlatform: 'Kubernetes', author: ref(publisherID) },
  ];
}

function collection(kind) {
  const blog = kind === 'blog';
  return { '@type': blog ? 'Blog' : 'CollectionPage',
    '@id': `${url(`${kind}/`)}#${blog ? 'blog' : 'webpage'}`,
    name: blog ? 'Paprika engineering blog' : 'Paprika documentation',
    url: url(`${kind}/`), isPartOf: ref(websiteID), publisher: ref(publisherID), inLanguage: 'en' };
}

function articleEntity(item) {
  const canonical = url(item.route);
  return { '@type': item.kind === 'blog' ? 'BlogPosting' : 'TechArticle',
    '@id': `${canonical}#article`, headline: item.title, description: item.description,
    url: canonical, mainEntityOfPage: ref(`${canonical}#webpage`),
    author: ref(publisherID), publisher: ref(publisherID), inLanguage: 'en',
    about: ref(softwareID), isPartOf: ref(collection(item.kind)['@id']),
    articleSection: item.kind === 'blog' ? item.category : item.section,
    // Publication days are editorial metadata; never substitute build times.
    ...(item.kind === 'blog' ? { datePublished: item.date } : {}),
    // The generic social preview is not an illustration of each article.
  };
}

export function pageStructuredData({ route, title, description, breadcrumbs = [], article, listing }) {
  const canonical = url(route);
  const webpage = { '@type': listing ? 'CollectionPage' : 'WebPage', '@id': `${canonical}#webpage`,
    url: canonical, name: title, description, inLanguage: 'en',
    isPartOf: ref(websiteID), publisher: ref(publisherID), about: ref(softwareID) };
  const graph = [...sharedEntities(), webpage];
  if (breadcrumbs.length >= 2) {
    webpage.breadcrumb = ref(`${canonical}#breadcrumb`);
    graph.push({ '@type': 'BreadcrumbList', '@id': `${canonical}#breadcrumb`,
      itemListElement: breadcrumbs.map((item, index) => ({ '@type': 'ListItem',
        position: index + 1, name: item.name, item: url(item.route) })) });
  }
  if (!route) webpage.mainEntity = ref(softwareID);
  if (article) {
    webpage.mainEntity = ref(`${canonical}#article`);
    graph.push(collection(article.kind), articleEntity(article));
  }
  if (listing) {
    // A directory describes linked pages; full article markup belongs on each article.
    const listID = `${canonical}#articles`;
    webpage.mainEntity = ref(listID);
    graph.push({ '@type': 'ItemList', '@id': listID, numberOfItems: listing.length,
      itemListElement: listing.map((item, index) => ({ '@type': 'ListItem',
        position: index + 1, name: item.title, url: url(item.route) })) });
    if (route === 'blog/') {
      const blog = collection('blog');
      blog.mainEntityOfPage = ref(webpage['@id']);
      webpage.about = [ref(softwareID), ref(blog['@id'])];
      graph.push(blog);
    }
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}
