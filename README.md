# Em dia — Relatórios mensais

Aplicativo em português para acompanhar relatórios mensais, cadastrar publicadores e períodos de pioneiro, e gerar PDFs mensais e anuais.

A versão 4 usa Supabase Auth e um banco privado organizado por grupos e três perfis. O site público mostra somente o login. O administrador gerencia todos os grupos e usuários. O superintendente administra apenas seu grupo. O publicador consulta somente seu cartão e seus relatórios. Não há autoautorização nem catálogo público de grupos.

Ao entrar, o responsável vê o checklist do grupo vinculado à conta; o publicador vê Meu cartão. O vínculo também define o grupo inicial de uma conta administradora. Somente a administração pode consultar outro grupo pelo seletor no topo; essa consulta não altera o grupo padrão. Cada grupo possui base e revisão próprias. Dois superintendentes vinculados ao mesmo grupo administram a mesma lista.

O primeiro relatório enviado pelo publicador é recebido automaticamente. Se mudar um relatório já recebido, o reenvio aguarda decisão em Revisões: o responsável compara o recebido com a proposta e aceita ou ignora. Até a aceitação, o relatório recebido permanece válido. Cada envio e decisão verifica a versão para evitar que uma resposta atrasada sobrescreva outra edição. Participação, horas e estudos são os únicos campos enviados pelo publicador; a condição de pioneiro vem do cadastro e do histórico administrado pelo responsável.

Nos meses de pioneiro regular ou auxiliar, Meu cartão também oferece um diário de horas. O publicador registra horas e minutos em cada dia, edita os lançamentos e acompanha a soma do mês. Os lançamentos são salvos na nuvem e só aparecem para o acesso vinculado àquele cartão. Eles não são relatórios entregues e não alteram o total já recebido.

Após encerrar o mês, o publicador pode conferir a soma, informar os estudos bíblicos e enviar o relatório. O banco calcula o total a partir dos minutos salvos, conferindo as versões do diário e do relatório. A conversão para o relatório usa horas decimais com duas casas; por exemplo, 1h30 corresponde a 1,5h. Reenvios seguem a mesma aprovação pelo responsável. A opção de informar um total mensal manualmente continua disponível para meses encerrados e não modifica o diário. Totais recebidos antes da criação do diário não são distribuídos em dias automaticamente.

Em Publicadores → Editar, o administrador ou superintendente pode criar um acesso de publicador para aquele cartão ou transferir o cartão para outro grupo. A transferência leva o cadastro, o histórico, as revisões e o vínculo de login em uma única operação. O destinatário é escolhido em uma lista de nomes de grupos, sem acesso aos seus publicadores.

Na aba Publicadores, o botão Anual em cada cartão abre o relatório individual do ano correspondente ao mês de referência. O histórico exibe os 12 meses, o tipo de publicador ou pioneiro, a entrega, a participação, as horas e os estudos informados. O ano e o período podem ser ajustados; a mesma consulta pode ser exportada em PDF ou texto. Relatório pendente, participação não informada e mês sem acompanhamento permanecem distintos de uma participação marcada como Não.

Cada gravação compara a revisão esperada com a atual. Conflitos entre aparelhos exigem recarregar a base. Falhas de salvamento não são apresentadas como sucesso. A troca de grupo limpa a base anterior da interface antes de carregar a seguinte. Os relatórios ficam na memória da página e no banco; apenas a sessão de login é persistida pelo SDK.

Dados da versão local anterior não são importados nem apagados silenciosamente. Exporte essa base e confira antes de substituir a base na nuvem. Importar um backup substitui os registros do grupo selecionado, sem mesclar. Mantenha backups JSON e PDFs em um lugar privado fora deste repositório.

O backup JSON do grupo contém os cadastros e relatórios recebidos, sem os diários privados dos publicadores. Os diários permanecem no banco e acompanham a transferência do cartão; não são incluídos no arquivo público nem no cache de instalação. Preserve também cópias privadas do banco por uma administração confiável.

O site funciona no GitHub Pages, branch main, pasta / (root), com .nojekyll. Não há compilação. O SDK Supabase está incluído em assets/vendor, com versão exata, licença e dependências fixadas no lockfile.

A versão 3.1 mantém a apresentação de celular em todas as telas: cartões em duas colunas, listas em uma coluna, navegação inferior e formulários em painel inferior. Grupos, usuários e regras de acesso permanecem disponíveis.

Em Dados, na tela de entrada ou em Ajuda, use “Instalar no celular”. Navegadores compatíveis mostram a confirmação de instalação; no iPhone, siga as instruções para adicionar pelo Safari à Tela de Início. A instalação continua exigindo login e internet para consultar ou salvar relatórios. O serviço de cache guarda somente uma lista explícita de arquivos públicos do aplicativo, sem respostas de autenticação, contas, relatórios, backups ou consultas do Supabase.

assets/config.js contém somente URL, chave pública publishable e retorno de login. Senhas, chaves secretas, e-mails, IDs reais e backups não pertencem ao código público. supabase/schema.sql documenta a estrutura inicial, supabase/groups-upgrade.sql adapta uma instalação existente por grupos e supabase/migrations/ contém a evolução dos perfis, sem identidades pessoais.

A aba Usuários é exclusiva da administração. Nela, cadastre administradores e superintendentes, escolhendo um grupo existente ou criando um novo. O acesso de publicador é criado pelo cartão correspondente. Mudar o grupo de um responsável não move os publicadores; para mudar um publicador, use a transferência do cartão. O comando Gerenciar grupos no topo permite criar grupos. A função de servidor em-dia-users verifica a sessão e a permissão necessária antes de usar a API privada de autenticação. Chaves de servidor ficam somente nas variáveis protegidas do Supabase.

Com Node.js 22 ou posterior:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Leia também [PRIVACIDADE.md](PRIVACIDADE.md), [PUBLICAR.md](PUBLICAR.md) e [TESTES.md](TESTES.md).
