# Em dia — Relatórios mensais

Aplicativo em português para acompanhar relatórios mensais, cadastrar publicadores e períodos de pioneiro, e gerar PDFs mensais e anuais.

A versão 2 usa Supabase Auth e um banco privado. O site público mostra somente o login. Uma lista privada de contas autorizadas e regras por linha permitem consultar apenas a base da própria conta. Não há autoautorização pelo aplicativo.

Cada gravação compara a revisão esperada com a atual. Conflitos entre aparelhos exigem recarregar a base. Falhas de salvamento não são apresentadas como sucesso. Os relatórios ficam na memória da página e no banco; apenas a sessão de login é persistida pelo SDK.

Dados da versão local anterior não são importados nem apagados silenciosamente. Exporte essa base e confira antes de substituir a base na nuvem. Importar um backup substitui os registros da conta inteira, sem mesclar. Mantenha backups JSON e PDFs em um lugar privado fora deste repositório.

O site funciona no GitHub Pages, branch main, pasta / (root), com .nojekyll. Não há compilação. O SDK Supabase está incluído em assets/vendor, com versão exata, licença e dependências fixadas no lockfile.

assets/config.js contém somente URL, chave pública publishable e retorno de login. Senhas, chaves secretas, e-mails, IDs reais dos responsáveis e backups não pertencem ao código público. supabase/schema.sql documenta a estrutura sem incluir contas ou dados pessoais.

Com Node.js 22 ou posterior:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Leia também [PRIVACIDADE.md](PRIVACIDADE.md), [PUBLICAR.md](PUBLICAR.md) e [TESTES.md](TESTES.md).
