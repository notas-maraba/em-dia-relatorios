# Em dia — Relatórios mensais

Aplicativo em português para acompanhar relatórios mensais, cadastrar publicadores e períodos de pioneiro, e gerar PDFs mensais e anuais.

A versão 3 usa Supabase Auth e um banco privado organizado por grupos. O site público mostra somente o login. Cada responsável vê apenas seu grupo; a administração pode gerenciar grupos e vincular usuários. Não há autoautorização nem catálogo público de grupos.

Ao entrar, o checklist abre diretamente no grupo vinculado à conta. Esse vínculo também define o grupo inicial de uma conta administradora. Somente a administração pode consultar outro grupo pelo seletor no topo; essa consulta não altera o grupo padrão. Cada grupo possui base e revisão próprias. Dois responsáveis vinculados ao mesmo grupo administram a mesma lista.

Na aba Publicadores, o botão Anual em cada cartão abre o relatório individual do ano correspondente ao mês de referência. O histórico exibe os 12 meses, o tipo de publicador ou pioneiro, a entrega, a participação, as horas e os estudos informados. O ano e o período podem ser ajustados; a mesma consulta pode ser exportada em PDF ou texto. Relatório pendente, participação não informada e mês sem acompanhamento permanecem distintos de uma participação marcada como Não.

Cada gravação compara a revisão esperada com a atual. Conflitos entre aparelhos exigem recarregar a base. Falhas de salvamento não são apresentadas como sucesso. A troca de grupo limpa a base anterior da interface antes de carregar a seguinte. Os relatórios ficam na memória da página e no banco; apenas a sessão de login é persistida pelo SDK.

Dados da versão local anterior não são importados nem apagados silenciosamente. Exporte essa base e confira antes de substituir a base na nuvem. Importar um backup substitui os registros do grupo selecionado, sem mesclar. Mantenha backups JSON e PDFs em um lugar privado fora deste repositório.

O site funciona no GitHub Pages, branch main, pasta / (root), com .nojekyll. Não há compilação. O SDK Supabase está incluído em assets/vendor, com versão exata, licença e dependências fixadas no lockfile.

A versão 3.1 mantém a apresentação de celular em todas as telas: cartões em duas colunas, listas em uma coluna, navegação inferior e formulários em painel inferior. Grupos, usuários e regras de acesso permanecem disponíveis.

Em Dados, na tela de entrada ou em Ajuda, use “Instalar no celular”. Navegadores compatíveis mostram a confirmação de instalação; no iPhone, siga as instruções para adicionar pelo Safari à Tela de Início. A instalação continua exigindo login e internet para consultar ou salvar relatórios. O serviço de cache guarda somente uma lista explícita de arquivos públicos do aplicativo, sem respostas de autenticação, contas, relatórios, backups ou consultas do Supabase.

assets/config.js contém somente URL, chave pública publishable e retorno de login. Senhas, chaves secretas, e-mails, IDs reais dos responsáveis e backups não pertencem ao código público. supabase/schema.sql documenta a estrutura inicial e supabase/groups-upgrade.sql adapta uma instalação existente por grupos, sem incluir identidades pessoais.

A aba Usuários é exclusiva da administração. Ao cadastrar uma conta, escolha um grupo existente ou crie um novo. Contas existentes podem ser vinculadas ou movidas sem apagar os relatórios do grupo; para um administrador, esse vínculo define o grupo padrão de entrada. O comando Gerenciar grupos no topo preserva a criação de grupos. A função de servidor em-dia-users verifica o usuário e sua permissão de administrador antes de usar a API privada de autenticação. Chaves de servidor ficam somente nas variáveis protegidas do Supabase.

Com Node.js 22 ou posterior:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Leia também [PRIVACIDADE.md](PRIVACIDADE.md), [PUBLICAR.md](PUBLICAR.md) e [TESTES.md](TESTES.md).
