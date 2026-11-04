# Em dia — Relatórios mensais

Aplicativo em português para acompanhar relatórios mensais, cadastrar publicadores e períodos de pioneiro, e gerar PDFs mensais e anuais.

A versão 3 usa Supabase Auth e um banco privado organizado por grupos. O site público mostra somente o login. Cada responsável vê apenas seu grupo; a administração pode gerenciar grupos e vincular usuários. Não há autoautorização nem catálogo público de grupos.

Na aba Grupos, escolha uma lista para abrir seu checklist, cadastros e relatórios. Cada grupo possui base e revisão próprias. Dois responsáveis vinculados ao mesmo grupo administram a mesma lista. Cada responsável regular tem um vínculo; uma conta administradora pode consultar todos os grupos.

Cada gravação compara a revisão esperada com a atual. Conflitos entre aparelhos exigem recarregar a base. Falhas de salvamento não são apresentadas como sucesso. A troca de grupo limpa a base anterior da interface antes de carregar a seguinte. Os relatórios ficam na memória da página e no banco; apenas a sessão de login é persistida pelo SDK.

Dados da versão local anterior não são importados nem apagados silenciosamente. Exporte essa base e confira antes de substituir a base na nuvem. Importar um backup substitui os registros do grupo selecionado, sem mesclar. Mantenha backups JSON e PDFs em um lugar privado fora deste repositório.

O site funciona no GitHub Pages, branch main, pasta / (root), com .nojekyll. Não há compilação. O SDK Supabase está incluído em assets/vendor, com versão exata, licença e dependências fixadas no lockfile.

assets/config.js contém somente URL, chave pública publishable e retorno de login. Senhas, chaves secretas, e-mails, IDs reais dos responsáveis e backups não pertencem ao código público. supabase/schema.sql documenta a estrutura inicial e supabase/groups-upgrade.sql adapta uma instalação existente por grupos, sem incluir identidades pessoais.

A aba Usuários é exclusiva da administração. Ao cadastrar uma conta, escolha um grupo existente ou crie um novo. Contas existentes podem ser vinculadas ou movidas sem apagar os relatórios do grupo. A função de servidor em-dia-users verifica o usuário e sua permissão de administrador antes de usar a API privada de autenticação. Chaves de servidor ficam somente nas variáveis protegidas do Supabase.

Com Node.js 22 ou posterior:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Leia também [PRIVACIDADE.md](PRIVACIDADE.md), [PUBLICAR.md](PUBLICAR.md) e [TESTES.md](TESTES.md).
